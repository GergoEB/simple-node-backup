const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const axios = require('axios');
const util = require('util');
const execPromise = util.promisify(exec);

// Configuration
const config = {
  webhookUrl: '',
  maxBackups: 4, // Default max backups
  backupRootDir: './',
  webhookUsername: 'Oracle Backup',
};

// Define backup modules
const backupModules = {
  mariadb: {
    name: 'MariaDB',
    iconUrl: 'https://mariadb.com/wp-content/uploads/2019/11/mariadb-logo-vertical_white.svg',
    color: 13637,
    backupDir: path.join(config.backupRootDir, 'mariadb_backups'),
    maxBackups: 6, // Module-specific max backups
    run: runMariaDbBackup,
    getBackupFiles: () => getBackupFiles('mariadb_backup_*.tar.gz', 'mariadb_backups'),
  },
  timescaledb: {
    name: 'TimescaleDB',
    iconUrl: 'https://s3.amazonaws.com/assets.timescale.com/timescale-web/brand-images/badge/yellow/logo-yellow.svg',
    color: 16121728,
    backupDir: path.join(config.backupRootDir, 'timescaledb_backups'),
    maxBackups: 6, // Module-specific max backups
    run: runTimescaleDbBackup,
    getBackupFiles: () => getBackupFiles('*', 'timescaledb_backups'),
  },
  nginx: {
    name: 'Nginx',
    iconUrl: 'https://www.vectorlogo.zone/logos/nginx/nginx-icon.svg',
    color: 38457,
    backupDir: path.join(config.backupRootDir, 'nginx_backups'),
    maxBackups: 12, // Module-specific max backups
    run: runNginxBackup,
    getBackupFiles: () => getBackupFiles('nginx_backup_*.tar.gz', 'nginx_backups'),
  },
  pterodactyl: {
    name: 'Pterodactyl',
    iconUrl: 'https://pterodactyl.io/logos/pterry.svg',
    color: 868992,
    backupDir: path.join(config.backupRootDir, 'pterodactyl_backups'),
    maxBackups: 4, // Module-specific max backups
    run: runPterodactylBackup,
    getBackupFiles: () => {
      // For Pterodactyl, get the directories which are date-based
      const backupDirs = getDirectories(path.join(config.backupRootDir, 'pterodactyl_backups'));
      return backupDirs.map(dir => `backup_${dir}`);
    },
  },
};

// Console styling
const colors = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  purple: '\x1b[35m',
  reset: '\x1b[0m',
};

// Helper function to get directories
function getDirectories(source) {
  return fs.readdirSync(source, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);
}

// Helper function to get backup files
function getBackupFiles(pattern, subdir) {
  const dir = path.join(config.backupRootDir, subdir);
  if (!fs.existsSync(dir)) return [];
  
  const files = fs.readdirSync(dir);
  const regex = new RegExp(pattern.replace(/\*/g, '.*'));
  return files.filter(file => regex.test(file))
    .sort((a, b) => {
      const statA = fs.statSync(path.join(dir, a));
      const statB = fs.statSync(path.join(dir, b));
      return statB.mtime.getTime() - statA.mtime.getTime(); // Sort by date, newest first
    });
}

// Helper function to clean up old backups
async function cleanupOldBackups(pattern, dir, moduleMaxBackups) {
  const backupDir = path.join(config.backupRootDir, dir);
  if (!fs.existsSync(backupDir)) return { removed: 0 };

  const backupFiles = getBackupFiles(pattern, dir);
  
  // Use module-specific maxBackups or fall back to default
  const maxBackups = moduleMaxBackups || config.maxBackups;
  
  if (backupFiles.length <= maxBackups) {
    return { removed: 0 };
  }
  
  console.log(`${colors.cyan}Cleaning up old backups for ${dir} (keeping ${maxBackups})...${colors.reset}`);
  
  const filesToDelete = backupFiles.slice(maxBackups);
  let removed = 0;
  
  for (const file of filesToDelete) {
    const filePath = path.join(backupDir, file);
    try {
      fs.unlinkSync(filePath);
      removed++;
    } catch (err) {
      console.error(`${colors.red}Failed to delete ${filePath}: ${err}${colors.reset}`);
    }
  }
  
  console.log(`${colors.green}Removed ${removed} old backup(s).${colors.reset}`);
  return { removed };
}

// MariaDB backup function
async function runMariaDbBackup() {
  const backupDir = backupModules.mariadb.backupDir;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '').split('T')[0];
  const backupName = `mariadb_backup_${timestamp}`;
  const fullBackupPath = path.join(backupDir, backupName);
  const compressedFile = `${backupName}.tar.gz`;
  
  // Create backup directory if it doesn't exist
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  console.log(`${colors.cyan}Starting MariaDB backup using mariabackup...${colors.reset}`);
  
  let logs = [];
  let originalSize = '';
  let compressedSize = '';
  
  try {
    // Step 1: Create a full backup using mariabackup
    logs.push('Creating full backup...');
    await execPromise(`sudo /usr/bin/mariadb-backup --backup --target-dir="${fullBackupPath}"`);
    
    // Step 2: Prepare the backup for use
    logs.push('Preparing backup...');
    console.log(`${colors.cyan}Preparing backup...${colors.reset}`);
    await execPromise(`sudo /usr/bin/mariadb-backup --prepare --target-dir="${fullBackupPath}"`);
    
    // Step 3: Compress the backup
    logs.push('Compressing backup...');
    console.log(`${colors.cyan}Compressing backup...${colors.purple}`);
    await execPromise(`sudo chown -R ${process.env.USER}: ${backupDir}`);
    
    // Get original size before compression
    const { stdout: duOutput } = await execPromise(`du -sh "${fullBackupPath}"`);
    originalSize = duOutput.split('\t')[0].trim();
    
    await execPromise(`tar -czf "${path.join(backupDir, compressedFile)}" -C "${backupDir}" "${backupName}"`);
    
    // Get compressed size
    const { stdout: compressedOutput } = await execPromise(`du -sh "${path.join(backupDir, compressedFile)}"`);
    compressedSize = compressedOutput.split('\t')[0].trim();
    
    // Remove the uncompressed backup directory
    await execPromise(`rm -rf "${fullBackupPath}"`);
    
    logs.push(`Backup completed: ${compressedFile} (Size: ${originalSize} -> ${compressedSize})`);
    console.log(`\n${colors.green}✓ Backup completed: ${backupDir}/${compressedFile} (Size: ${compressedSize})${colors.reset}`);
    
    // Step 4: Delete old backups (use module-specific maxBackups)
    const cleanup = await cleanupOldBackups('mariadb_backup_*.tar.gz', 'mariadb_backups', backupModules.mariadb.maxBackups);
    logs.push(`Cleaned up ${cleanup.removed} old backups (keeping ${backupModules.mariadb.maxBackups}).`);
    
    return {
      success: true,
      logs,
      originalSize,
      compressedSize,
      backupFiles: backupModules.mariadb.getBackupFiles(),
    };
  } catch (error) {
    console.error(`${colors.red}MariaDB backup failed: ${error.message}${colors.reset}`);
    return {
      success: false,
      logs: [...logs, `ERROR: ${error.message}`],
      error: error.message,
    };
  }
}

// TimescaleDB backup function
async function runTimescaleDbBackup() {
  const backupRootDir = path.join(config.backupRootDir, 'timescaledb_backups');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '').split('T')[0];
  const containerName = "TimescaleDB";
  const databases = ["mindustry_stats", "mindustry_stats_dev"]; // Add your database names here
  
  // Create backup directory if it doesn't exist
  if (!fs.existsSync(backupRootDir)) {
    fs.mkdirSync(backupRootDir, { recursive: true });
  }

  let logs = [];
  let totalOriginalSize = 0;
  let totalCompressedSize = 0;
  let backupCount = 0;
  
  try {
    // Check if container is running
    const { stdout: dockerPs } = await execPromise(`sudo docker ps`);
    if (!dockerPs.includes(containerName)) {
      throw new Error(`TimescaleDB container '${containerName}' is not running.`);
    }
    
    for (const db of databases) {
      console.log(`\n${colors.cyan}=== Processing database: ${db} ===${colors.reset}`);
      logs.push(`Processing database: ${db}`);
      
      // Create database-specific backup directory
      const dbBackupDir = path.join(backupRootDir, timestamp, db);
      if (!fs.existsSync(dbBackupDir)) {
        fs.mkdirSync(dbBackupDir, { recursive: true });
      }
      
      const backupFile = `${db}_${timestamp}.sql`;
      const compressedFile = `${backupFile}.gz`;
      
      console.log(`${colors.cyan}Creating SQL dump for ${db}...${colors.reset}`);
      
      // Execute pg_dump through Docker and compress on-the-fly
      await execPromise(`sudo docker exec ${containerName} pg_dump -C ${db} | gzip > "${path.join(dbBackupDir, compressedFile)}"`);
      
      // Get size of compressed backup
      const { stdout: sizeOutput } = await execPromise(`du -h "${path.join(dbBackupDir, compressedFile)}"`);
      const backupSize = sizeOutput.split('\t')[0].trim();
      
      console.log(`${colors.green}✓ Backup completed: ${dbBackupDir}/${compressedFile} (Size: ${backupSize})${colors.reset}`);
      logs.push(`${db} backup completed: ${compressedFile} (Size: ${backupSize})`);
      
      // Store for total size calculation (approximate since we're using human-readable sizes)
      const numericSize = parseFloat(backupSize.replace(/[^0-9.]/g, ''));
      const unit = backupSize.replace(/[0-9.]/g, '').trim();
      if (unit.includes('K')) totalCompressedSize += numericSize * 1024;
      else if (unit.includes('M')) totalCompressedSize += numericSize * 1024 * 1024;
      else if (unit.includes('G')) totalCompressedSize += numericSize * 1024 * 1024 * 1024;
      else totalCompressedSize += numericSize;
      
      backupCount++;
      
      // Clean up old backups for this database
      await cleanupOldBackups('*.sql.gz', path.join('timescaledb_backups', db), backupModules.timescaledb.maxBackups);
    }
    
    // Calculate total compressed size in human-readable format
    const totalCompressedSizeHuman = totalCompressedSize > 1024 * 1024 * 1024 ? 
      `${(totalCompressedSize / (1024 * 1024 * 1024)).toFixed(2)}GB` :
      totalCompressedSize > 1024 * 1024 ? 
        `${(totalCompressedSize / (1024 * 1024)).toFixed(2)}MB` :
        `${(totalCompressedSize / 1024).toFixed(2)}KB`;
    
    console.log(`\n${colors.green}===== Backup Summary =====${colors.reset}`);
    console.log(`${colors.green}Total backups across all databases: ${backupCount}${colors.reset}`);
    console.log(`${colors.green}Backup location: ${backupRootDir}/{database_name}/${colors.reset}`);
    console.log(`${colors.green}Timestamp: ${timestamp}${colors.reset}`);
    
    logs.push(`Total backups: ${backupCount}, Total size: ${totalCompressedSizeHuman}`);
    
    return {
      success: true,
      logs,
      compressedSize: totalCompressedSizeHuman,
      backupFiles: backupModules.timescaledb.getBackupFiles(),
    };
  } catch (error) {
    console.error(`${colors.red}TimescaleDB backup failed: ${error.message}${colors.reset}`);
    return {
      success: false,
      logs: [...logs, `ERROR: ${error.message}`],
      error: error.message,
    };
  }
}

// Nginx backup function
async function runNginxBackup() {
  const backupDir = backupModules.nginx.backupDir;
  const nginxDir = "/etc/nginx";
  const timestamp = new Date().toISOString().split('T')[0].replace(/-/g, '-');
  const archiveName = `nginx_backup_${timestamp}.tar.gz`;
  
  // Create backup directory if it doesn't exist
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  
  let logs = [];
  let originalSize = '';
  let compressedSize = '';
  
  try {
    // Step 1: Calculate the size before archiving
    console.log(`${colors.cyan}Calculating size of ${nginxDir}...${colors.reset}`);
    const { stdout: duOutput } = await execPromise(`du -sh "${nginxDir}"`);
    originalSize = duOutput.split('\t')[0].trim();
    console.log(`${colors.cyan}Original size of ${nginxDir}: ${originalSize}${colors.reset}`);
    logs.push(`Original size of ${nginxDir}: ${originalSize}`);
    
    console.log(`${colors.cyan}Creating backup archive: ${backupDir}/${archiveName}...${colors.purple}`);
    logs.push(`Creating backup archive: ${archiveName}`);
    
    // Create a tar.gz archive of the /etc/nginx directory
    await execPromise(`tar -czvf "${path.join(backupDir, archiveName)}" -C /etc nginx`);
    
    // Calculate the size after archiving
    const { stdout: compressedOutput } = await execPromise(`du -sh "${path.join(backupDir, archiveName)}"`);
    compressedSize = compressedOutput.split('\t')[0].trim();
    
    console.log(`\n${colors.green}Backup of /etc/nginx completed.${colors.reset}`);
    console.log(`${colors.green}Archive saved as ${backupDir}/${archiveName} (Size: ${originalSize} -> ${compressedSize})${colors.reset}`);
    
    logs.push(`Backup completed: ${archiveName} (Size: ${originalSize} -> ${compressedSize})`);
    
    // Step 4: Delete old backups (use module-specific maxBackups)
    const cleanup = await cleanupOldBackups('nginx_backup_*.tar.gz', 'nginx_backups', backupModules.nginx.maxBackups);
    logs.push(`Cleaned up ${cleanup.removed} old backups (keeping ${backupModules.nginx.maxBackups}).`);
    
    return {
      success: true,
      logs,
      originalSize,
      compressedSize,
      backupFiles: backupModules.nginx.getBackupFiles(),
    };
  } catch (error) {
    console.error(`${colors.red}Nginx backup failed: ${error.message}${colors.reset}`);
    return {
      success: false,
      logs: [...logs, `ERROR: ${error.message}`],
      error: error.message,
    };
  }
}

// Pterodactyl backup function
async function runPterodactylBackup() {
  const baseDir = "/var/lib/pterodactyl/volumes";
  const sizeThreshold = 1000; // in MB
  const currentDate = new Date().toISOString().split('T')[0];
  const outputDir = path.join(backupModules.pterodactyl.backupDir, `backup_${currentDate}`);
  
  // Create output directory for individual tar files
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  let logs = [];
  let totalOriginalSize = 0;
  let totalCompressedSize = 0;
  
  try {
    // Step 0: Backup our app key and other Pterodactyl files
    console.log(`${colors.cyan}Backing up Pterodactyl environment file...${colors.reset}`);
    logs.push('Backing up Pterodactyl environment file...');
    
    try {
      await execPromise(`cp "/var/www/pterodactyl/.env" "${outputDir}/panel.env"`);
      console.log(`${colors.green}Environment file backed up successfully.${colors.reset}`);
      logs.push('Environment file backed up successfully.');
    } catch (envError) {
      console.error(`${colors.red}Failed to backup environment file: ${envError.message}${colors.reset}`);
      logs.push(`Failed to backup environment file: ${envError.message}`);
    }
    
    // Step 1: Create a .tar file for each folder below the size threshold
    console.log(`${colors.cyan}Creating .tar files for folders under ${sizeThreshold}MB...${colors.reset}`);
    logs.push(`Creating .tar files for folders under ${sizeThreshold}MB...`);
    
    const { stdout: foldersOutput } = await execPromise(`find "${baseDir}" -mindepth 1 -maxdepth 1 -type d`);
    const folders = foldersOutput.trim().split('\n');
    
    for (const folder of folders) {
      const { stdout: folderSizeOutput } = await execPromise(`du -sm "${folder}"`);
      const folderSize = parseInt(folderSizeOutput.split('\t')[0]);
      
      if (folderSize < sizeThreshold) {
        const folderName = path.basename(folder);
        console.log(`${colors.cyan}Creating archive for ${folderName} (Size: ${folderSize}MB)...${colors.reset}`);
        logs.push(`Creating archive for ${folderName} (Size: ${folderSize}MB)`);
        
        try {
          console.log(`${colors.purple}`);
          await execPromise(`tar -cf "${path.join(outputDir, `${folderName}.tar`)}" -C "${baseDir}" "${folderName}"`);
          console.log(`${colors.green}Archive created for ${folderName}.${colors.reset}\n`);
          logs.push(`Archive created for ${folderName}.`);
          
          totalOriginalSize += folderSize;
        } catch (tarError) {
          console.error(`${colors.red}Failed to create archive for ${folderName}: ${tarError.message}${colors.reset}\n`);
          logs.push(`Failed to create archive for ${folderName}: ${tarError.message}`);
        }
      }
    }
    
    // Step 2: Compress all .tar files and display size reduction
    console.log(`${colors.cyan}Compressing all tar files...${colors.reset}`);
    logs.push('Compressing all tar files...');
    
    const { stdout: tarFilesOutput } = await execPromise(`find "${outputDir}" -type f -name "*.tar"`);
    const tarFiles = tarFilesOutput.trim() ? tarFilesOutput.trim().split('\n') : [];
    
    for (const tarFile of tarFiles) {
      const { stdout: originalSizeOutput } = await execPromise(`du -sh "${tarFile}"`);
      const originalFileSize = originalSizeOutput.split('\t')[0].trim();
      
      console.log(`${colors.cyan}Compressing ${path.basename(tarFile)} (Original size: ${originalFileSize})...${colors.reset}`);
      
      try {
        await execPromise(`gzip -9 "${tarFile}"`);
        const compressedFile = `${tarFile}.gz`;
        const { stdout: compressedSizeOutput } = await execPromise(`du -sh "${compressedFile}"`);
        const compressedFileSize = compressedSizeOutput.split('\t')[0].trim();
        
        console.log(`${colors.green}Compressed ${path.basename(compressedFile)} (Size: ${originalFileSize} -> ${compressedFileSize}).${colors.reset}\n`);
        logs.push(`Compressed ${path.basename(compressedFile)} (Size: ${originalFileSize} -> ${compressedFileSize})`);
        
        // Calculate total compressed size (approximate)
        const numericSize = parseFloat(compressedFileSize.replace(/[^0-9.]/g, ''));
        const unit = compressedFileSize.replace(/[0-9.]/g, '').trim();
        if (unit.includes('K')) totalCompressedSize += numericSize * 1024;
        else if (unit.includes('M')) totalCompressedSize += numericSize * 1024 * 1024;
        else if (unit.includes('G')) totalCompressedSize += numericSize * 1024 * 1024 * 1024;
        else totalCompressedSize += numericSize;
        
      } catch (gzipError) {
        console.error(`${colors.red}Failed to compress ${path.basename(tarFile)}: ${gzipError.message}${colors.reset}\n`);
        logs.push(`Failed to compress ${path.basename(tarFile)}: ${gzipError.message}`);
      }
    }
    
    // Calculate total size in human-readable format
    const totalOriginalSizeHuman = totalOriginalSize > 1024 ? 
      `${(totalOriginalSize / 1024).toFixed(2)}GB` : `${totalOriginalSize}MB`;
    
    const totalCompressedSizeHuman = totalCompressedSize > 1024 * 1024 * 1024 ? 
      `${(totalCompressedSize / (1024 * 1024 * 1024)).toFixed(2)}GB` :
      totalCompressedSize > 1024 * 1024 ? 
        `${(totalCompressedSize / (1024 * 1024)).toFixed(2)}MB` :
        `${(totalCompressedSize / 1024).toFixed(2)}KB`;
    
    console.log(`${colors.green}All folders under ${sizeThreshold}MB have been archived and compressed.${colors.reset}`);
    logs.push(`All folders under ${sizeThreshold}MB have been archived and compressed.`);
    logs.push(`Total size: ${totalOriginalSizeHuman} -> ${totalCompressedSizeHuman}`);
    
    // Check if we need to remove old backup folders (use module-specific maxBackups)
    const backupDirs = getDirectories(backupModules.pterodactyl.backupDir)
      .filter(dir => dir.startsWith('backup_'))
      .sort((a, b) => b.localeCompare(a)); // Sort by name in descending order (newest first)
    
    const moduleMaxBackups = backupModules.pterodactyl.maxBackups;
    
    if (backupDirs.length > moduleMaxBackups) {
      console.log(`${colors.cyan}Cleaning up old Pterodactyl backups (keeping ${moduleMaxBackups})...${colors.reset}`);
      logs.push(`Cleaning up old Pterodactyl backups (keeping ${moduleMaxBackups})...`);
      
      const dirsToRemove = backupDirs.slice(moduleMaxBackups);
      for (const dirToRemove of dirsToRemove) {
        const dirPath = path.join(backupModules.pterodactyl.backupDir, dirToRemove);
        try {
          await execPromise(`rm -rf "${dirPath}"`);
          logs.push(`Removed old backup: ${dirToRemove}`);
        } catch (rmError) {
          console.error(`${colors.red}Failed to remove old backup ${dirToRemove}: ${rmError.message}${colors.reset}`);
          logs.push(`Failed to remove old backup ${dirToRemove}: ${rmError.message}`);
        }
      }
      
      console.log(`${colors.green}Removed ${dirsToRemove.length} old backup(s).${colors.reset}`);
      logs.push(`Removed ${dirsToRemove.length} old backup(s).`);
    }
    
    return {
      success: true,
      logs,
      originalSize: totalOriginalSizeHuman,
      compressedSize: totalCompressedSizeHuman,
      backupFiles: backupModules.pterodactyl.getBackupFiles(),
    };
  } catch (error) {
    console.error(`${colors.red}Pterodactyl backup failed: ${error.message}${colors.reset}`);
    return {
      success: false,
      logs: [...logs, `ERROR: ${error.message}`],
      error: error.message,
    };
  }
}

// Send Discord webhook notification for combined results
async function sendCombinedDiscordNotification(results) {
  if (!config.webhookUrl || config.webhookUrl === 'YOUR_DISCORD_WEBHOOK_URL_HERE') {
    console.log(`${colors.yellow}Discord webhook URL not configured. Skipping notification.${colors.reset}`);
    return;
  }
  
  try {
    const embeds = [];
    let successCount = 0;
    let failureCount = 0;
    
    // Create embeds for each backup result
    for (const [moduleName, result] of Object.entries(results)) {
      const module = backupModules[moduleName];
      const backupFiles = result.backupFiles || [];
      
      // Count successes and failures
      if (result.success) {
        successCount++;
      } else {
        failureCount++;
      }
      
      // Format the list of available backups (max 10 to avoid clutter)
      const backupsAvailable = backupFiles
        .slice(0, 10)
        .map(file => {
          // Extract date from filename using improved pattern matching
          let displayName = '';
          
          // Try to extract date based on common patterns
          if (file.match(/\d{4}-\d{2}-\d{2}/)) {
            // Format with dashes like 2024-06-01
            const dateMatch = file.match(/(\d{4})-(\d{2})-(\d{2})/);
            if (dateMatch) {
              displayName = `${dateMatch[3]}/${dateMatch[2]}/${dateMatch[1]}`;
            }
          } else if (file.match(/\d{8}/)) {
            // Format like 20240601
            const dateMatch = file.match(/(\d{4})(\d{2})(\d{2})/);
            if (dateMatch) {
              displayName = `${dateMatch[3]}/${dateMatch[2]}/${dateMatch[1]}`;
            }
          } else if (file.startsWith('backup_')) {
            // Handle Pterodactyl backup directories
            const dirDate = file.replace('backup_', '');
            displayName = dirDate.split('-').reverse().join('/');
          }
          
          if (!displayName) {
            displayName = file; // Fallback to the full filename
          }
          
          // Try to get the file size
          try {
            const filePath = path.join(module.backupDir, file);
            if (fs.existsSync(filePath)) {
              const stats = fs.statSync(filePath);
              // Convert bytes to MB or GB
              let size;
              if (stats.isDirectory()) {
                displayName = `📁 ${displayName}`;
              } else if (stats.size > 1024 * 1024 * 1024) {
                size = `${(stats.size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
                displayName = `📄 ${displayName} (${size})`;
              } else {
                size = `${(stats.size / (1024 * 1024)).toFixed(2)} MB`;
                displayName = `📄 ${displayName} (${size})`;
              }
            }
          } catch (err) {
            // If we can't get the size, just display the name
          }
          
          return `- ${displayName}`;
        })
        .sort()
        .join('\n');
      
      embeds.push({
        title: `${module.name} Backup ${result.success ? 'Completed' : 'Failed'} (Size: \`${result.compressedSize || 'FAILED'}\`)`,
        description: `**Logs:**\n\`\`\`\n${result.logs.slice(-10).join('\n')}\n\`\`\`\n**Backups Available:**\n${backupsAvailable || 'No backups found'}\nMax ${module.maxBackups}, Currently ${Math.min(backupFiles.length, module.maxBackups)} backups`,
        color: result.success ? module.color : 15158332, // Red color for failures
        author: {
          name: module.name,
          icon_url: module.iconUrl
        }
      });
    }
    
    // Create the summary content
    let content = `✅ Backup Summary: ${successCount} completed`;
    if (failureCount > 0) {
      content += `, ❌ ${failureCount} failed`;
    }
    
    // Prepare the webhook payload
    const payload = {
      content: content,
      embeds: embeds,
      username: config.webhookUsername,
      attachments: []
    };
    
    console.log(`${colors.cyan}Sending combined Discord notification for ${Object.keys(results).length} backup modules...${colors.reset}`);
    await axios.post(config.webhookUrl, payload);
    console.log(`${colors.green}Combined Discord notification sent successfully.${colors.reset}`);
  } catch (error) {
    console.error(`${colors.red}Failed to send combined Discord notification: ${error.message}${colors.reset}`);
  }
}

// Send Discord webhook notification for a single backup
async function sendDiscordNotification(module, results) {
  if (!config.webhookUrl || config.webhookUrl === 'YOUR_DISCORD_WEBHOOK_URL_HERE') {
    console.log(`${colors.yellow}Discord webhook URL not configured. Skipping notification.${colors.reset}`);
    return;
  }
  
  try {
    const { name, iconUrl, color } = backupModules[module];
    const backupFiles = results.backupFiles || [];
    
    // Format the list of available backups (max 10 to avoid clutter)
    const backupsAvailable = backupFiles
      .slice(0, 10)
      .map(file => {
        // Extract date from filename using improved pattern matching
        let displayName = '';
        
        // Try to extract date based on common patterns
        if (file.match(/\d{4}-\d{2}-\d{2}/)) {
          // Format with dashes like 2024-06-01
          const dateMatch = file.match(/(\d{4})-(\d{2})-(\d{2})/);
          if (dateMatch) {
            displayName = `${dateMatch[3]}/${dateMatch[2]}/${dateMatch[1]}`;
          }
        } else if (file.match(/\d{8}/)) {
          // Format like 20240601
          const dateMatch = file.match(/(\d{4})(\d{2})(\d{2})/);
          if (dateMatch) {
            displayName = `${dateMatch[3]}/${dateMatch[2]}/${dateMatch[1]}`;
          }
        } else if (file.startsWith('backup_')) {
          // Handle Pterodactyl backup directories
          const dirDate = file.replace('backup_', '');
          displayName = dirDate.split('-').reverse().join('/');
        }
        
        if (!displayName) {
          displayName = file; // Fallback to the full filename
        }
        
        // Try to get the file size
        try {
          const filePath = path.join(backupModules[module].backupDir, file);
          if (fs.existsSync(filePath)) {
            const stats = fs.statSync(filePath);
            // Convert bytes to MB or GB
            let size;
            if (stats.isDirectory()) {
              displayName = `📁 ${displayName}`;
            } else if (stats.size > 1024 * 1024 * 1024) {
              size = `${(stats.size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
              displayName = `📄 ${displayName} (${size})`;
            } else {
              size = `${(stats.size / (1024 * 1024)).toFixed(2)} MB`;
              displayName = `📄 ${displayName} (${size})`;
            }
          }
        } catch (err) {
          // If we can't get the size, just display the name
        }
        
        return `- ${displayName}`;
      })
      .join('\n');
    
    // Prepare the webhook payload
    const payload = {
      content: `✅ Completed ${name} Backup\n💽 Size${results.originalSize ? ' (Unzipped)' : ''}: \`${results.compressedSize}\`${results.originalSize ? ` (\`${results.originalSize}\`)` : ''}`,
      embeds: [
        {
          title: `Backup Completed (Size: \`${results.compressedSize}\`)`,
          description: `**Logs:**\n\`\`\`\n${results.logs.slice(-10).join('\n')}\n\`\`\`\n**Backups Available:**\n${backupsAvailable || 'No backups found'}\nMax ${backupModules[module].maxBackups}, Currently ${Math.min(backupFiles.length, backupModules[module].maxBackups)} backups`,
          color: color,
          author: {
            name: name,
            icon_url: iconUrl
          }
        }
      ],
      username: config.webhookUsername,
      attachments: []
    };
    
    console.log(`${colors.cyan}Sending Discord notification for ${name} backup...${colors.reset}`);
    await axios.post(config.webhookUrl, payload);
    console.log(`${colors.green}Discord notification sent successfully.${colors.reset}`);
  } catch (error) {
    console.error(`${colors.red}Failed to send Discord notification: ${error.message}${colors.reset}`);
  }
}

// Main function to run a specific backup module
async function runBackup(moduleName) {
  const module = backupModules[moduleName];
  if (!module) {
    console.error(`${colors.red}Module '${moduleName}' not found.${colors.reset}`);
    return { success: false, moduleName };
  }
  
  console.log(`\n${colors.cyan}Running ${module.name} backup...${colors.reset}\n`);
  
  try {
    // Create the backup directory if it doesn't exist
    if (!fs.existsSync(module.backupDir)) {
      fs.mkdirSync(module.backupDir, { recursive: true });
    }
    
    // Run the backup
    const results = await module.run();
    
    if (results.success) {
      console.log(`\n${colors.green}${module.name} backup completed successfully.${colors.reset}`);
      return { ...results, backupFiles: module.getBackupFiles(), moduleName };
    } else {
      console.error(`\n${colors.red}${module.name} backup failed. Please check for errors.${colors.reset}`);
      return { 
        ...results, 
        moduleName,
        compressedSize: 'FAILED',
        backupFiles: module.getBackupFiles()
      };
    }
  } catch (error) {
    console.error(`\n${colors.red}${module.name} backup failed with error: ${error.message}${colors.reset}`);
    
    return {
      success: false,
      logs: [`ERROR: ${error.message}`],
      compressedSize: 'FAILED',
      backupFiles: module.getBackupFiles(),
      moduleName
    };
  }
}

// Main function to run all backups
async function runAllBackups() {
  console.log(`${colors.cyan}Starting all backup processes...${colors.reset}`);
  
  // Ensure backup root directory exists
  if (!fs.existsSync(config.backupRootDir)) {
    fs.mkdirSync(config.backupRootDir, { recursive: true });
  }
  
  // Run backups and collect results
  const results = {};
  
  // Run database backups first
  results.mariadb = await runBackup('mariadb');
  results.timescaledb = await runBackup('timescaledb');
  
  // Then run other backups
  results.nginx = await runBackup('nginx');
  results.pterodactyl = await runBackup('pterodactyl');
  
  // Send combined notification
  await sendCombinedDiscordNotification(results);
  
  console.log(`${colors.cyan}All backup scripts finished.${colors.reset}`);
}

// Create a run script for individual components
async function main() {
  // Get command line arguments
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === '--all') {
    // Run all backups if no specific module is specified
    await runAllBackups();
  } else {
    // Run specific modules
    const results = {};
    
    for (const moduleName of args) {
      const normalizedName = moduleName.toLowerCase().replace(/^--/, '');
      if (backupModules[normalizedName]) {
        const result = await runBackup(normalizedName);
        results[normalizedName] = result;
      } else {
        console.error(`${colors.red}Unknown module: ${moduleName}${colors.reset}`);
        console.log(`Available modules: ${Object.keys(backupModules).join(', ')}`);
      }
    }
    
    // If multiple modules were run, send a combined notification
    if (Object.keys(results).length > 1) {
      await sendCombinedDiscordNotification(results);
    } else if (Object.keys(results).length === 1) {
      // For a single module, use the original notification function
      const moduleName = Object.keys(results)[0];
      await sendDiscordNotification(moduleName, results[moduleName]);
    }
  }
}

// Run the main function
main().catch(error => {
  console.error(`${colors.red}Fatal error: ${error.message}${colors.reset}`);
  process.exit(1);
});