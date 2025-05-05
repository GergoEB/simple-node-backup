> [!INFO]
> This project was made using AI in around 30 minutes - It works for me but there is no guarantee it will for your specific situation :)

# Node.js Backup System

This is a Node.js implementation of an automatic backup system that can handle backups for:

* MariaDB
* TimescaleDB
* Nginx
* Pterodactyl

I made it in around 30 minutes using some AI - and it seems to be working correctly.

## Features

* Automated backups for multiple services
* Cleanup of old backups (configurable retention)
* Discord webhook notifications with backup summary
* Colorized console output
* Individual or bulk backup execution

---

## Installation

1. Clone this repository to your server
2. Install dependencies:

```bash
npm install axios
```

3. Update the `config` object in `backup-system.js` with your Discord webhook URL (optional)
4. Make the script executable:

```bash
chmod +x backup-system.js
```

## Usage

### Run all backups

```bash
node backup-system.js --all
```

### Run specific backups

```bash
node backup-system.js mariadb timescaledb
node backup-system.js nginx pterodactyl
```

## Configuration

The main configuration is at the top of `backup-system.js`:

```javascript
const config = {
  webhookUrl: 'YOUR_DISCORD_WEBHOOK_URL_HERE', // Required for Discord notifications
  maxBackups: 14, // Default Number of backups to keep
  backupRootDir: './backups', // Root directory for all backups
  webhookUsername: 'Oracle Backup', // Username for Discord webhook
};
```

## Requirements

* Node.js 14+
* Sudo privileges for backup operations
* MariaDB, TimescaleDB, Nginx, Pterodactyl installed (depending on what you want to back up)
* Docker (for TimescaleDB backup)

## Discord Notifications

The system sends a Discord notification on backup completion with:

* Backup size (compressed and uncompressed)
* Recent logs
* List of available backups
* Current backup count and maximum retention

## Setting up as a Cron Job

To run backups automatically, set up a cron job:

```bash
# Edit crontab
crontab -e

# Add this line to run on Tuesdays at midnight
0 0 * * 2 cd /path/to/backup-scripts && node backup-system.js --all > /path/to/backup.log 2>&1
```
