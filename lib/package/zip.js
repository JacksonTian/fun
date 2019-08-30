// require modules
'use strict';

const fs = require('fs-extra');
const uuid = require('uuid');
const path = require('path');
const util = require('util');
const tempDir = require('temp-dir');
const bytes = require('bytes');

const debug = require('debug')('fun:zip');
const JSZip = require('jszip');
const glob = require('glob');
const archiver = require('archiver');

const { createProgressBar } = require('../import/utils');

const _ = require('lodash');
const { green, grey } = require('colors');

const readdir = util.promisify(fs.readdir);
const lstat = util.promisify(fs.lstat);

const { buildDeps, read } = require('../deps');
const readlink = util.promisify(fs.readlink);

function globAsync(pattern, cwd) {
  return new Promise((resolve, reject) => {
    glob(pattern, {
      cwd
    }, (err, list) => {
      if (err) {
        return reject(err);
      }
      resolve(list);
    });
  });
}

function permStr(mode) {
  return (mode & 0o777).toString(8);
}

exports.compress = async function (func, rootDir, type) {
  const deps = await buildDeps(func, rootDir, type);

  const zip = new JSZip();
  if (deps) {
    debug('load deps zip');
    zip.loadAsync(deps, {
      base64: true
    });
  }

  debug('append files: %s', func.codes.join(','));

  var jobs = [];
  const list = new Set(func.codes);
  for (var item of list) {
    jobs.push(globAsync(item, rootDir));
  }

  const results = await Promise.all(jobs);
  for (let list of results) {
    for (let filename of list) {
      const filepath = path.join(rootDir, filename);
      const stats = await lstat(filepath);
      if (stats.isFile()) {
        zip.file(filename, fs.createReadStream(filepath), {
          unixPermissions: permStr(stats.mode)
        });
      } else if (stats.isSymbolicLink()) {
        // see https://github.com/Stuk/jszip/issues/428
        zip.file(filename, await readlink(filepath), {
          unixPermissions: '120' + permStr(stats.mode)
        });
      }
    }
  }

  return zip.generateAsync({type: 'base64', platform: 'UNIX'});
};

async function zipFolder(zipArchiver, folder, folders, funignore, codeUri) {
  folders.push(folder);
  const dir = path.join(...folders);

  let count = 0;
  
  await Promise.all((await readdir(dir)).map(async (f) => {

    const fPath = path.join(dir, f);

    debug('before zip: lstat fPath: %s, absolute fPath is %s', fPath, path.resolve(fPath));

    let s;

    try {
      s = await lstat(fPath);
    } catch (error) {
      debug(`before zip: could not found fPath ${fPath}, absolute fPath is ${path.resolve(fPath)}, exception is ${error}, skiping`);
      return;
    }

    if (funignore && funignore(fPath)) {
      debug('file %s is ignored.', fPath);
      return;
    }

    const absFilePath = path.resolve(fPath);
    const absCodeUri = path.resolve(codeUri);
    const relative = path.relative(absCodeUri, absFilePath);

    if (s.isFile() || s.isSymbolicLink()) {
      zipArchiver.file(fPath, {
        name: relative, 
        stats: s // The archiver uses fs.stat by default, and pasing the result of lstat to ensure that the symbolic link is properly packaged
      });

      count++;
    } else if (s.isDirectory()) {

      let folderFilesCount = await zipFolder(zipArchiver, f, folders.slice(), funignore, codeUri);

      count += folderFilesCount;
    } else {
      console.error(`ignore file ${absFilePath}, because it isn't a file, symbolic link or directory`);
    }
  }));
  return count;
}

async function generateAsync(zip) {
  return await zip.generateAsync({
    type: 'base64',
    platform: 'UNIX',
    compression: 'DEFLATE',
    compressionOptions: {
      level: 9
    }
  });
}

exports.packFromJson = async function (files) {
  const zip = new JSZip();

  _.forEach(files, (content, path) => {
    zip.file(path, content);
  });

  return await generateAsync(zip);
};

exports.pack = async function (file, funignore) {

  if (!(await fs.pathExists(file))) {
    throw new Error('zip file %s is not exist.', file);
  }

  debug('pack file file is %s, absFilePath is %s', file, path.resolve(file));

  const stats = await lstat(file);

  if (funignore && funignore(file)) {
    throw new Error('file %s is ignored.', file);
  }

  const randomDirName = uuid.v4();
  const randomDir = path.join(tempDir, randomDirName);

  await fs.ensureDir(randomDir);

  const zipPath = path.join(randomDir, 'code.zip');

  const bar = createProgressBar(`${green(':zipping')} :bar :current/:total :rate files/s, :percent :etas`, { total: 0 } );

  const output = fs.createWriteStream(zipPath);
  const zipArchiver = archiver('zip', {
    zlib: {
      level: 9
    }
  });

  zipArchiver.on('progress', (progress) => {

    bar.total = progress.entries.total;

    bar.tick({
      total: progress.entries.processed
    });
  });

  zipArchiver.on('warning', function (err) {
    console.warn(err);
  });

  zipArchiver.on('error', function (err) {
    console.log(`    ${green('x')} ${grey('zip error')}`);
  });

  output.on('close', () => {
    if (zipArchiver.pointer() > 52428800) { // 50M

      console.log(`We detected that the compressed size of your code package is ${bytes(zipArchiver.pointer())}`);
    }
  });

  zipArchiver.pipe(output);

  let count = 0;

  if (stats.isFile()) {
    debug('append file: %s', file);

    zipArchiver.append(fs.createReadStream(file), {'name': path.basename(file)});

    count++;
  } else if (stats.isDirectory()) {
    debug('append folder: %s, absolute path is %s', file, path.resolve(file));

    count = await zipFolder(zipArchiver, file, [], funignore, file);
  } else {

    throw new Error('file %s must be a regular file or directory.', file);
  }

  zipArchiver.finalize(zipPath);

  const base64 = await read(zipArchiver, 'base64');

  await fs.remove(randomDir);

  return { base64, count };
};