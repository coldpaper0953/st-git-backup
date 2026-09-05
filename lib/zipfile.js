// st-git-backup — zip creation/extraction helpers.
// Uses archiver (bundled with SillyTavern) to stream the data directory into a
// zip, and yauzl (also bundled) to extract snapshots back to disk.

'use strict';

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const yauzl = require('yauzl');

const RETRY_DELAY_MS = 400;
const RETRY_COUNT = 3;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Recursively list files under rootDir whose relative path passes isExcluded.
// Directory read errors (permissions on locked folders) are skipped silently —
// the per-file open check below is what surfaces real failures.
function listFiles(rootDir, isExcluded) {
    const files = [];
    const walk = (dir, rel) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const relPath = rel ? `${rel}/${entry.name}` : entry.name;
            if (isExcluded(relPath, entry.isDirectory())) {
                continue;
            }
            if (entry.isDirectory()) {
                walk(path.join(dir, entry.name), relPath);
            } else if (entry.isFile()) {
                files.push({ abs: path.join(dir, entry.name), rel: relPath });
            }
        }
    };
    walk(rootDir, '');
    return files;
}

// Open every file once before archiving so that files locked by a running
// process (Windows EBUSY/EPERM) fail early with a clear list instead of
// aborting a half-written zip.
async function checkReadable(files) {
    const failures = [];
    for (const file of files) {
        let ok = false;
        for (let attempt = 0; attempt < RETRY_COUNT && !ok; attempt++) {
            try {
                const handle = await fs.promises.open(file.abs, 'r');
                await handle.close();
                ok = true;
            } catch {
                await sleep(RETRY_DELAY_MS);
            }
        }
        if (!ok) {
            failures.push(file.rel);
        }
    }
    if (failures.length > 0) {
        const err = new Error(`以下文件被占用，暂时无法读取（请稍后重试）：\n${failures.join('\n')}`);
        err.code = 'FILES_LOCKED';
        throw err;
    }
}

// Zip rootDir into outPath, keeping only paths that pass isExcluded.
// Returns { size, fileCount }.
async function zipDirectory(rootDir, outPath, isExcluded) {
    const files = listFiles(rootDir, isExcluded);
    if (files.length === 0) {
        const err = new Error('数据目录为空（或全部内容都在排除列表中），没有可备份的内容');
        err.code = 'EMPTY_DATA';
        throw err;
    }
    await checkReadable(files);

    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
    await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outPath);
        const archive = archiver('zip', { zlib: { level: 6 } });
        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);
        // A file vanishing between the open check and the archive stream is a
        // harmless race (SillyTavern rewrites its json files constantly).
        archive.on('warning', (err) => {
            if (err && err.code !== 'ENOENT') {
                reject(err);
            }
        });
        archive.pipe(output);
        for (const file of files) {
            archive.file(file.abs, { name: file.rel, mode: 0o644 });
        }
        archive.finalize();
    });

    const size = fs.statSync(outPath).size;
    if (size === 0) {
        const err = new Error('生成的备份压缩包为空');
        err.code = 'EMPTY_ZIP';
        throw err;
    }
    return { size, fileCount: files.length };
}

// Defend against zip-slip: entry names must stay inside destDir.
function safeEntryPath(destDir, entryName) {
    const normalized = path.posix.normalize(entryName);
    if (normalized.startsWith('..') || path.posix.isAbsolute(normalized) || normalized === '') {
        return null;
    }
    return path.join(destDir, normalized);
}

// Extract zipPath into destDir. Returns the number of extracted files.
async function extractZip(zipPath, destDir) {
    await fs.promises.mkdir(destDir, { recursive: true });
    return new Promise((resolve, reject) => {
        yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
            if (err) {
                return reject(err);
            }
            let extracted = 0;
            const fail = (err2) => {
                try { zipfile.close(); } catch { /* already closed */ }
                reject(err2);
            };
            zipfile.on('error', fail);
            zipfile.on('entry', (entry) => {
                const abs = safeEntryPath(destDir, entry.fileName);
                if (!abs) {
                    zipfile.readEntry();
                    return;
                }
                if (entry.fileName.endsWith('/')) {
                    fs.mkdir(abs, { recursive: true }, () => zipfile.readEntry());
                    return;
                }
                fs.mkdir(path.dirname(abs), { recursive: true }, (mkdirErr) => {
                    if (mkdirErr) {
                        return fail(mkdirErr);
                    }
                    zipfile.openReadStream(entry, (streamErr, readStream) => {
                        if (streamErr) {
                            return fail(streamErr);
                        }
                        const writeStream = fs.createWriteStream(abs);
                        writeStream.on('error', fail);
                        readStream.on('error', fail);
                        writeStream.on('close', () => {
                            extracted++;
                            zipfile.readEntry();
                        });
                        readStream.pipe(writeStream);
                    });
                });
            });
            zipfile.on('end', () => resolve(extracted));
            zipfile.readEntry();
        });
    });
}

// Copy everything from srcDir over destDir (recursive, overwriting).
function copyInto(srcDir, destDir) {
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
        const src = path.join(srcDir, entry.name);
        const dest = path.join(destDir, entry.name);
        if (entry.isDirectory()) {
            fs.mkdirSync(dest, { recursive: true });
            copyInto(src, dest);
        } else if (entry.isFile()) {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
        }
    }
}

module.exports = { listFiles, zipDirectory, extractZip, copyInto, sleep };
