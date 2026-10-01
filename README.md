# 読書 — Reading Tracker

[![screenshot-1](https://via.placeholder.com/800x450/e0e0e0/333333?text=App+Screenshot+1)](https://via.placeholder.com/800x450/e0e0e0/333333?text=App+Screenshot+1)
[![screenshot-2](https://via.placeholder.com/800x450/e0e0e0/333333?text=App+Screenshot+2)](https://via.placeholder.com/800x450/e0e0e0/333333?text=App+Screenshot+2)

A minimal Electron desktop app for tracking reading sessions with SQLite storage.

## Origin

Little project started mostly as a test for the capabilities of Qwen 3.6 35B A3B, turned out pretty nice.

At first I tried to use the built-in Kindle reading stats to make a reading streak plugin, only to discover the stats are completely broken for Japanese books. My monkey brain does like streak calendars and I do want to force myself to read more, so I still wanted to make something along that idea.

By manually placing `krs.start` and `krs.end` notes on the books I'm reading on my Kindle, I can extract the date and hour of each note as well as its position. Using those and a DRM-free copy of the book, I can then extract the exact character count as well. With those three, I can get an accurate-ish measurement of my reading habits, and procrastinate reading by vibe-coding an app that probably already exists.

## Functionalities

- **Reading Session Tracking** — Log sessions by date, title, language, and duration
- **Activity Heatmap** — Visualize reading streaks and habits over time
- **Bulk CSV Import** — Import multiple sessions at once via CSV with flexible column mapping
- **Kindle Sync** — Pull sidecar and book data from a jailbroken Kindle via SSH and extract reading sessions
- **Database Backup & Restore** — Export and import the SQLite database

## Kindle Sync

Requires you to manually add notes containing `krs.start` and `krs.end` when you start and end your reading sessions.
This app does not use the Kindle's built-in reading statistics. Use [kindle-reading-dashboard](https://github.com/zevisvei/kindle-reading-dashboard) for that.

Kindle sidecar parsing and sync scripts are heavily inspired by [kindle-reading-dashboard](https://github.com/zevisvei/kindle-reading-dashboard). This project relies on [KRDS](https://github.com/K-R-D-S/KRDS) for sidecar data extraction and utilizes the kfxlib from the koreader plugin: [kaikozlov/kindle.koplugin](https://github.com/kaikozlov/kindle.koplugin).

#### Kindle Sync Setup

1. deDRM your books :)
2. Ensure your Kindle is jailbroken and has SSH enabled
3. Click the ⚙ icon (top-right) to enter Kindle host and credentials
4. Click "Kindle Sync" to pull sidecar data and extract reading sessions

#### Kindle Sync Settings

| Field       | Default          | Description               |
| ----------- | ---------------- | ------------------------- |
| Kindle Host | `192.168.15.244` | Kindle's local IP address |
| Kindle User | `root`           | SSH username              |
| Password    | `kindle`         | SSH password              |

## Setup

#### if using Kindle Sync

Install Python 3.8+ for your platform: https://www.python.org/downloads/
install the dependencies:

```bash
pip install -r python-bundle/requirements.txt --target python-bundle/python/Lib/site-packages
```

#### Electron App

```bash
npm install
npm start
```

```bash
npm install
npm run build:nsis
```

### Database Location

- Windows: `%APPDATA%\reading-tracker\data.db`

### Tech Stack

- Electron — Desktop app shell
- better-sqlite3 — Fast, local SQLite database
- Vanilla JS + CSS — UI
- Python - Kindle stuff
