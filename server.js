const express = require("express");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const multer = require("multer");
const cors = require("cors");
const csv = require('csv-parser');
const { Readable } = require('stream');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static("public"));

// Configure multer for file upload
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dir = 'uploads';
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir);
        }
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ storage: storage });

// Calculate similarity between two values
function calculateValueSimilarity(val1, val2) {
    if (val1 === val2) return 100;
    if (!val1 || !val2) return 0;

    // Handle numeric values
    if (typeof val1 === 'number' && typeof val2 === 'number') {
        const max = Math.max(Math.abs(val1), Math.abs(val2));
        if (max === 0) return 100;
        return (1 - Math.abs(val1 - val2) / max) * 100;
    }

    // Handle string values
    const str1 = String(val1).toLowerCase().trim();
    const str2 = String(val2).toLowerCase().trim();

    if (str1 === str2) return 100;

    let matches = 0;
    const length = Math.max(str1.length, str2.length);
    
    for (let i = 0; i < Math.min(str1.length, str2.length); i++) {
        if (str1[i] === str2[i]) matches++;
    }

    return (matches / length) * 100;
}

// Calculate similarity between two records
function calculateRecordSimilarity(record1, record2) {
    const keys1 = Object.keys(record1);
    const keys2 = Object.keys(record2);
    const allKeys = [...new Set([...keys1, ...keys2])];
    
    if (allKeys.length === 0) return 0;

    let totalSimilarity = 0;
    let totalWeight = 0;

    for (const key of allKeys) {
        // Skip if key doesn't exist in both records
        if (!record1.hasOwnProperty(key) || !record2.hasOwnProperty(key)) continue;

        // Calculate weight based on field type
        let weight = 1;
        if (key.toLowerCase().includes('id')) weight = 0.5; // Less weight for IDs
        if (key.toLowerCase().includes('name')) weight = 2; // More weight for names
        
        const similarity = calculateValueSimilarity(record1[key], record2[key]);
        totalSimilarity += similarity * weight;
        totalWeight += weight;
    }

    return totalWeight > 0 ? totalSimilarity / totalWeight : 0;
}

// Find duplicates with similarity threshold
function findDuplicates(data, threshold = 70) {
    const duplicateGroups = [];
    const processed = new Set();

    for (let i = 0; i < data.length; i++) {
        if (processed.has(i)) continue;

        const group = {
            groupId: duplicateGroups.length + 1,
            original: data[i],
            duplicates: []
        };

        for (let j = i + 1; j < data.length; j++) {
            if (processed.has(j)) continue;

            const similarity = calculateRecordSimilarity(data[i], data[j]);
            if (similarity >= threshold) {
                group.duplicates.push({
                    record: data[j],
                    similarity: similarity.toFixed(2),
                    index: j
                });
                processed.add(j);
            }
        }

        if (group.duplicates.length > 0) {
            group.duplicates.sort((a, b) => parseFloat(b.similarity) - parseFloat(a.similarity));
            duplicateGroups.push(group);
            processed.add(i);
        }
    }

    return duplicateGroups;
}

// Process CSV data
function processCSV(filePath) {
    return new Promise((resolve, reject) => {
        const results = [];
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (data) => results.push(data))
            .on('end', () => resolve(results))
            .on('error', reject);
    });
}

// Process Excel data
function processExcel(filePath) {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
}

// Convert data to specified format
function convertToFormat(data, format) {
    switch (format.toLowerCase()) {
        case 'xlsx':
        case 'xls': {
            const worksheet = XLSX.utils.json_to_sheet(data);
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
            return {
                buffer: XLSX.write(workbook, { type: 'buffer', bookType: format }),
                extension: format
            };
        }
        case 'csv': {
            const worksheet = XLSX.utils.json_to_sheet(data);
            return {
                buffer: Buffer.from(XLSX.utils.sheet_to_csv(worksheet)),
                extension: 'csv'
            };
        }
        case 'json':
        default:
            return {
                buffer: Buffer.from(JSON.stringify(data, null, 2)),
                extension: 'json'
            };
    }
}

// Process uploaded file
function processUploadedFile(file) {
    const fileExt = path.extname(file.originalname).toLowerCase();
    let data;

    // Process file based on type
    switch (fileExt) {
        case '.csv':
            data = processCSV(file.path);
            break;
        case '.xlsx':
        case '.xls':
            data = processExcel(file.path);
            break;
        case '.json':
            data = JSON.parse(fs.readFileSync(file.path, 'utf8'));
            break;
        default:
            throw new Error('Unsupported file format');
    }

    return data;
}

// Find all duplicates in data
function findAllDuplicates(data, threshold) {
    return findDuplicates(data, threshold);
}

// Upload endpoint
app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        const threshold = parseFloat(req.query.threshold) || 70;
        const file = req.file;
        
        if (!file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const data = await processUploadedFile(file);
        const duplicateGroups = findAllDuplicates(data, threshold);
        
        // Calculate detailed statistics
        const totalRecords = data.length;
        let duplicateCount = 0;
        duplicateGroups.forEach(group => {
            duplicateCount += group.duplicates.length;
        });
        
        const uniqueRecords = totalRecords - duplicateCount;
        const redundancyPercentage = ((duplicateCount / totalRecords) * 100).toFixed(1);

        res.json({
            success: true,
            totalRecords,
            uniqueRecords,
            duplicateCount,
            redundancyPercentage,
            duplicateGroups,
            originalFormat: path.extname(file.originalname).toLowerCase().substring(1)
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    } finally {
        // Clean up uploaded file
        if (req.file) {
            fs.unlinkSync(req.file.path);
        }
    }
});

// Merge endpoint with format selection
app.post('/merge', async (req, res) => {
    try {
        const { data, selectedGroups, similarityThreshold = 70, outputFormat = 'xlsx' } = req.body;
        const timestamp = Date.now();

        // Keep track of processed records to avoid duplicates
        const processedKeys = new Set();
        const mergedData = [];

        // Helper function to generate a unique key for a record
        const getRecordKey = (record) => {
            return Object.entries(record)
                .filter(([key]) => !key.toLowerCase().includes('id')) // Exclude ID fields
                .map(([key, value]) => `${key}:${value}`)
                .sort()
                .join('|');
        };

        // Helper function to add a record if it's not a duplicate
        const addUniqueRecord = (record) => {
            const key = getRecordKey(record);
            if (!processedKeys.has(key)) {
                processedKeys.add(key);
                mergedData.push(record);
                return true;
            }
            return false;
        };

        // Process groups
        if (selectedGroups) {
            // Process only selected groups
            data.duplicateGroups.forEach(group => {
                if (selectedGroups.includes(group.groupId)) {
                    addUniqueRecord(group.original);
                    group.duplicates
                        .filter(dup => parseFloat(dup.similarity) >= similarityThreshold)
                        .forEach(dup => addUniqueRecord(dup.record));
                }
            });
        } else {
            // Process all groups
            data.duplicateGroups.forEach(group => {
                addUniqueRecord(group.original);
                group.duplicates
                    .filter(dup => parseFloat(dup.similarity) >= similarityThreshold)
                    .forEach(dup => addUniqueRecord(dup.record));
            });
        }

        // Convert to requested format
        const { buffer, extension } = convertToFormat(mergedData, outputFormat);
        const outputPath = path.join('uploads', `merged_${timestamp}.${extension}`);
        fs.writeFileSync(outputPath, buffer);

        res.json({
            success: true,
            fileName: path.basename(outputPath),
            mergedCount: mergedData.length,
            originalCount: data.totalRecords
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Ignore endpoint with proper duplicate handling
app.post('/ignore', async (req, res) => {
    try {
        const { data, selectedGroups } = req.body;
        
        // Create a set of records to ignore
        const ignoreSet = new Set();
        
        // Add all records from selected groups to ignore set
        selectedGroups.forEach(groupId => {
            const group = data.duplicateGroups.find(g => g.groupId === groupId);
            if (group) {
                // Add the key of original record
                ignoreSet.add(JSON.stringify(group.original));
                // Add the keys of all duplicates
                group.duplicates.forEach(dup => {
                    ignoreSet.add(JSON.stringify(dup.record));
                });
            }
        });

        // Update the duplicate groups by removing ignored groups
        const updatedGroups = data.duplicateGroups.filter(group => 
            !selectedGroups.includes(group.groupId)
        );

        // Send back updated data without actually creating a file
        res.json({
            success: true,
            message: `Ignored ${selectedGroups.length} groups`,
            remainingGroups: updatedGroups.length,
            ignoredCount: ignoreSet.size
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Download original data with format selection
app.post('/download/original', async (req, res) => {
    try {
        const { duplicateGroups, outputFormat = 'xlsx' } = req.body;
        const timestamp = Date.now();

        // Collect all records
        const allRecords = [];
        duplicateGroups.forEach(group => {
            allRecords.push(group.original);
            group.duplicates.forEach(dup => allRecords.push(dup.record));
        });

        // Convert to requested format
        const { buffer, extension } = convertToFormat(allRecords, outputFormat);
        const outputPath = path.join('uploads', `original_${timestamp}.${extension}`);
        fs.writeFileSync(outputPath, buffer);

        res.json({
            success: true,
            fileName: path.basename(outputPath)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Download merged data
app.post('/download/merged', async (req, res) => {
    try {
        const { data, selectedGroups, similarityThreshold = 70 } = req.body;
        const timestamp = Date.now();
        const outputPath = path.join('uploads', `merged_${timestamp}.${data.originalFormat}`);

        // Keep track of processed records to avoid duplicates
        const processedKeys = new Set();
        const mergedData = [];

        // Helper function to generate a unique key for a record
        const getRecordKey = (record) => {
            return Object.entries(record)
                .filter(([key]) => !key.toLowerCase().includes('id')) // Exclude ID fields
                .map(([key, value]) => `${key}:${value}`)
                .sort()
                .join('|');
        };

        // Helper function to add a record if it's not a duplicate
        const addUniqueRecord = (record) => {
            const key = getRecordKey(record);
            if (!processedKeys.has(key)) {
                processedKeys.add(key);
                mergedData.push(record);
                return true;
            }
            return false;
        };

        // Process selected groups
        data.duplicateGroups.forEach(group => {
            if (!selectedGroups || selectedGroups.includes(group.groupId)) {
                // Always try to keep the original record first
                addUniqueRecord(group.original);

                // Sort duplicates by similarity
                const sortedDuplicates = [...group.duplicates]
                    .sort((a, b) => parseFloat(b.similarity) - parseFloat(a.similarity));

                // Only add duplicates that meet the threshold and aren't already included
                sortedDuplicates.forEach(dup => {
                    if (parseFloat(dup.similarity) >= similarityThreshold) {
                        addUniqueRecord(dup.record);
                    }
                });
            } else {
                // For non-selected groups, keep the original record
                addUniqueRecord(group.original);
            }
        });

        // Convert and save the merged data
        const outputData = convertToFormat(mergedData, data.originalFormat);
        fs.writeFileSync(outputPath, outputData.buffer);

        res.json({
            success: true,
            fileName: path.basename(outputPath)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Download endpoint with MIME type handling
app.get('/download/:filename', (req, res) => {
    const filePath = path.join('uploads', req.params.filename);
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    const ext = path.extname(req.params.filename).toLowerCase();
    const mimeTypes = {
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.xls': 'application/vnd.ms-excel',
        '.csv': 'text/csv',
        '.json': 'application/json'
    };

    res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename}"`);

    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);

    fileStream.on('end', () => {
        // Clean up the file after download
        fs.unlinkSync(filePath);
    });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
