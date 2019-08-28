/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const db = require('../database/db');
const { getFolderList, deleteCoverImageFromDisk, saveCoverImageToDisk } = require('./utils');
const { createSchema } = require('../database/schema');
const scrapeWorkMetadata = require('../hvdb');

const config = require('../../../config.json');

/**
 * Takes a single folder, fetches metadata and adds it to the database.
 * @param {*} id Work id.
 * @param {*} folder Directory name (relative).
 */
const processFolder = (id, folder) => db.knex('t_work')
  .where('id', '=', id)
  .count()
  .first()
  .then((res) => {
    const count = res['count(*)'];

    if (count) {
      // Already in database.
      // console.log(` * ${folder} already in database, skipping.`);
      return 1;
    }

    // New folder.
    console.log(` * Found new folder: ${folder}`);
    const rjcode = (`000000${id}`).slice(-6); // zero-pad to 6 digits

    console.log(` -> [RJ${rjcode}] Fetching metadata from HVDB...`);
    return scrapeWorkMetadata(id)
      .then((metadata) => {
        console.log(` -> [RJ${rjcode}] Fetched metadata! Adding to database...`);

        // TODO: cover download could be in parallel with metadata fetch. Haven't
        // done it because if metadata fails, cover is useless. Consider for later.
        console.log(` -> [RJ${rjcode}] Downloading cover image...`);
        fetch(`https://hvdb.me/WorkImages/RJ${rjcode}.jpg`)
          .then((imageRes) => {
            saveCoverImageToDisk(imageRes.body, rjcode)
              .then(() => console.log(` -> [RJ${rjcode}] Cover image downloaded!`));
          });

        // eslint-disable-next-line no-param-reassign
        metadata.dir = folder;
        return db.insertWorkMetadata(metadata)
          .then(console.log(` -> [RJ${rjcode}] Finished adding to the database!`))
          .then(() => 0);
      })
      .catch((err) => {
        console.log(`  ! [RJ${rjcode}] Failed to fetch metadata from HVDB: ${err}`);
        return 0;
      });
  });

const performCleanup = () => {
  console.log(' * Looking for folders to clean up...');
  return db.knex('t_work')
    .select('id', 'dir')
    .then((works) => {
      const promises = works.map(work => new Promise((resolve, reject) => {
        if (!fs.existsSync(path.join(config.rootDir, work.dir))) {
          console.warn(` ! ${work.dir} is missing from filesystem. Removing from database...`);
          db.removeWork(work.id)
            .then((result) => {
              const rjcode = (`000000${work.id}`).slice(-6); // zero-pad to 6 digits
              deleteCoverImageFromDisk(rjcode)
                .catch(() => console.log(` -> [RJ${rjcode}] Failed to delete cover image.`))
                .then(() => resolve(result));
            })
            .catch(err => reject(err));
        } else {
          resolve();
        }
      }));

      return Promise.all(promises);
    });
};

const performScan = () => {
  fs.mkdir(path.join(config.rootDir, 'Images'), (direrr) => {
    if (direrr && direrr.code !== 'EEXIST') {
      console.error(` ! ERROR while trying to create Images folder: ${direrr}`);
      process.exit(1);
    }

    createSchema()
      .then(() => performCleanup())
      .catch((err) => {
        console.error(` ! ERROR while performing cleanup: ${err}`);
        process.exit(1);
      })
      .then(async () => {
        console.log(' * Finished cleanup. Starting scan...');
        const promises = [];

        try {
          for await (const folder of getFolderList()) {
            const id = folder.match(/RJ(\d{6})/)[1];
            promises.push(processFolder(id, folder));
          }
        } catch (err) {
          console.error(` ! ERROR while trying to get folder list: ${err}`);
          process.exit(1);
        }

        Promise.all(promises)
          .then((results) => {
            const skipCount = results.reduce((a, b) => a + b, 0);
            console.log(` * Finished scan. Skipped ${skipCount} folders already in database.`);
            db.knex.destroy();
          })
          .catch((err) => {
            console.error(` ! ERROR while performing scan: ${err}`);
            process.exit(1);
          });
      })
      .catch((err) => {
        console.error(` ! ERROR while creating schema: ${err}`);
        process.exit(1);
      });
  });
};

performScan();
