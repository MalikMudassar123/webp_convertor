const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const fsPromises = require('fs').promises;
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const app = express();
const upload = multer({
    dest: 'uploads/',
    limits: {
        fileSize: 100 * 1024 * 1024, // 100MB per file
        files: 100 // 100-file limit
    }
});
const PORT = 3000;

// Ensure directory exists
const ensureDir = async (dir) => {
    try {
        await fsPromises.mkdir(dir, { recursive: true }).then(() => console.log(`Created ${dir}`));
    } catch (err) {
        if (err.code !== 'EEXIST') throw err;
    }
};

// Serve static files
app.use(express.static('public'));
app.use('/output/:dir', (req, res, next) => express.static(path.join('public', req.params.dir))(req, res, next));

// Download route
app.get('/download/:dir/:filename', async (req, res) => {
    const filePath = path.join('public', req.params.dir, req.params.filename);
    console.log(`Downloading ${filePath}`);
    try {
        await fsPromises.access(filePath);
        res.download(filePath, req.params.filename, (err) => err && res.status(500).send('Download error'));
    } catch {
        res.status(404).send('File not found');
    }
});

// ZIP download route
app.get('/download-zip/:dir', async (req, res) => {
    const dirPath = path.join('public', req.params.dir);
    const zipPath = path.join('public', `${req.params.dir}.zip`);
    console.log(`Zipping ${dirPath}`);
    try {
        const files = await fsPromises.readdir(dirPath);
        if (!files.length) return res.status(404).send('No files to zip');
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        output.on('close', () => res.download(zipPath, `${req.params.dir}.zip`, (err) => {
            if (!err) fsPromises.unlink(zipPath).catch(console.error);
        }));
        archive.on('error', (err) => { throw err; });
        archive.pipe(output);
        archive.directory(dirPath, false);
        archive.finalize();
    } catch (err) {
        res.status(500).send(`ZIP error: ${err.message}`);
    }
});

// Conversion route
app.post('/convert', upload.array('image'), async (req, res) => {
    try {
        console.log('Files received:', req.files.map(f => ({ name: f.originalname, size: f.size, mimetype: f.mimetype })));
        if (!req.files?.length) return res.status(400).json({ error: 'No files uploaded' });

        const outputDir = path.join('public', `output_${Date.now()}`);
        await ensureDir(outputDir);

        const fileSizes = [];
        for (const file of req.files) {
            const outputPath = path.join(outputDir, `${path.basename(file.originalname, path.extname(file.originalname))}.webp`);
            console.log(`Processing ${file.originalname} (MIME: ${file.mimetype}) at ${file.path} to ${outputPath}`);
            try {
                const originalSize = (await fsPromises.stat(file.path)).size;
                const isWebP = file.mimetype === 'image/webp' || path.extname(file.originalname).toLowerCase() === '.webp';
                
                if (isWebP) {
                    await fsPromises.copyFile(file.path, outputPath);
                    console.log(`Copied ${file.originalname} (already WebP) to ${outputPath}`);
                    fileSizes.push({ originalName: file.originalname, originalSize, convertedSize: originalSize, isWebP: true });
                } else {
                    await sharp(file.path)
                        .webp({ quality: 90, effort: 4 }) // Adjusted for size reduction with good quality
                        .toFile(outputPath);
                    const convertedSize = (await fsPromises.stat(outputPath)).size;
                    console.log(`Converted ${file.originalname} to ${convertedSize} bytes`);
                    if (convertedSize < 512) {
                        console.error(`Conversion failed for ${file.originalname}: size too small (${convertedSize} bytes)`);
                        await fsPromises.unlink(outputPath).catch(() => {});
                        throw new Error('Size too small');
                    }
                    // Skip conversion if WebP size exceeds original size
                    if (convertedSize >= originalSize) {
                        console.log(`WebP size (${convertedSize}) exceeds original (${originalSize}), retaining original format`);
                        await fsPromises.unlink(outputPath).catch(() => {});
                        fileSizes.push({ originalName: file.originalname, originalSize, convertedSize: originalSize, skipped: true });
                    } else {
                        fileSizes.push({ originalName: file.originalname, originalSize, convertedSize });
                    }
                }
                await fsPromises.unlink(file.path);
            } catch (err) {
                console.error(`Conversion error for ${file.originalname}:`, err.message, err.stack);
                fileSizes.push({ originalName: file.originalname, originalSize: file.size, convertedSize: file.size, error: true, errorDetail: err.message });
                await fsPromises.unlink(file.path).catch(() => {});
            }
        }

        const baseDir = path.basename(outputDir);
        const downloadUrls = fileSizes.map(f => `/download/${baseDir}/${path.basename(f.originalName, path.extname(f.originalName))}.webp`);
        const zipDownloadUrl = fileSizes.length && !fileSizes.every(f => f.error) ? `/download-zip/${baseDir}` : '';

        console.log('Download URLs:', downloadUrls, 'ZIP URL:', zipDownloadUrl, 'File Sizes:', fileSizes);
        res.json({ downloadUrls, zipDownloadUrl, fileSizes });
    } catch (err) {
        console.error('Overall conversion error:', err.message, err.stack);
        res.status(500).json({ error: `Conversion failed: ${err.message}` });
    }
});

app.listen(PORT, () => console.log(`Server on port ${PORT}`));