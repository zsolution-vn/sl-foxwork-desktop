// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import fs from 'fs';
import path from 'path';

import {dialog, ipcMain, app, nativeImage} from 'electron';
import type {ProgressInfo, UpdateInfo} from 'electron-updater';
import {autoUpdater, CancellationToken} from 'electron-updater';

import {
    CANCEL_UPGRADE,
    UPDATE_AVAILABLE,
    UPDATE_DOWNLOADED,
    CHECK_FOR_UPDATES,
    UPDATE_SHORTCUT_MENU,
    UPDATE_PROGRESS,
    NO_UPDATE_AVAILABLE,
    CANCEL_UPDATE_DOWNLOAD,
    UPDATE_REMIND_LATER,
} from 'common/communication';
import Config from 'common/config';
import {Logger} from 'common/log';
import downloadsManager from 'main/downloadsManager';
import {localizeMessage} from 'main/i18nManager';
import NotificationManager from 'main/notifications';

const NEXT_NOTIFY = 86400000; // 24 hours
const NEXT_CHECK = 3600000; // 1 hour

const log = new Logger('UpdateManager');
autoUpdater.logger = log;
autoUpdater.autoDownload = false;
autoUpdater.disableWebInstaller = true;

const assetsDir = path.resolve(app.getAppPath(), 'assets');
const appIconURL = path.resolve(assetsDir, 'appicon_with_spacing_32.png');
const appIcon = nativeImage.createFromPath(appIconURL);

/** to test this during development
 * add the following to electron-builder.json in the publish entry
    {
      "provider": "generic",
      "url": "http://localhost:8000"
    },
 * create a packaged build, copy that to a directory B (I usually do a third C copy to be able to go back without packaging again)
 * upgrade the package.json version
 * package a second copy of the app
 * on release dir setup an http server (using `python -m SimpleHTTPServer` should match the above entry)
 * start the app from directory B
 * if the app upgraded and you want to repeat, simply copy C into B if you did the C step, if not, package again.
 * yeah, it is a time consuming process :( improve this doc if you find a way to go faster.
**/

export class UpdateManager {
    cancellationToken?: CancellationToken;
    lastNotification?: NodeJS.Timeout;
    lastCheck?: NodeJS.Timeout;
    versionAvailable?: string;
    versionDownloaded?: string;
    downloadedInfo?: UpdateInfo;

    constructor() {
        this.cancellationToken = new CancellationToken();

        autoUpdater.on('error', (err: Error) => {
            log.error('There was an error while trying to update', err);
        });

        autoUpdater.on('update-available', (info: UpdateInfo) => {
            autoUpdater.removeListener('update-not-available', this.displayNoUpgrade);
            this.versionAvailable = info.version;
            ipcMain.emit(UPDATE_SHORTCUT_MENU);
            log.info('New version available:', info.version);
            this.notify();
        });

        autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
            this.versionDownloaded = info.version;
            this.downloadedInfo = info;
            ipcMain.emit(UPDATE_SHORTCUT_MENU);
            log.info('Downloaded version', info.version);
            this.notifyDownloaded();
        });

        autoUpdater.on('download-progress', (progress: ProgressInfo) => {
            ipcMain.emit(UPDATE_PROGRESS, null, progress);
        });

        ipcMain.on(CANCEL_UPGRADE, () => {
            log.info('User Canceled upgrade');
        });

        ipcMain.on(CHECK_FOR_UPDATES, () => {
            this.checkForUpdates(true);
        });

        ipcMain.on(CANCEL_UPDATE_DOWNLOAD, this.handleCancelDownload);
        ipcMain.on(UPDATE_REMIND_LATER, this.handleRemindLater);
    }

    notify = (): void => {
        if (this.lastNotification) {
            clearTimeout(this.lastNotification);
        }
        this.lastNotification = setTimeout(this.notify, NEXT_NOTIFY);
        if (this.versionDownloaded) {
            this.notifyDownloaded();
        } else if (this.versionAvailable) {
            this.notifyUpgrade();
        }
    };

    notifyUpgrade = (): void => {
        ipcMain.emit(UPDATE_AVAILABLE, null, this.versionAvailable);
        NotificationManager.displayUpgrade(this.versionAvailable || 'unknown', this.handleDownload);
    };

    notifyDownloaded = (): void => {
        ipcMain.emit(UPDATE_DOWNLOADED, null, this.downloadedInfo);
        NotificationManager.displayRestartToUpgrade(this.versionDownloaded || 'unknown', this.handleUpdate);
    };

    handleDownload = (): void => {
        if (this.lastCheck) {
            clearTimeout(this.lastCheck);
        }
        autoUpdater.downloadUpdate(this.cancellationToken);
    };

    handleCancelDownload = (): void => {
        this.cancellationToken?.cancel();
        this.cancellationToken = new CancellationToken();
    };

    handleRemindLater = (): void => {
        // TODO
    };

    handleOnQuit = (): void => {
        if (this.versionDownloaded) {
            autoUpdater.quitAndInstall(true, false);
        }
    };

    getReleaseNotes = (): string => {
        try {
            // Đọc từ CHANGELOG.md
            const changelogPath = path.join(process.cwd(), 'CHANGELOG.md');
            if (fs.existsSync(changelogPath)) {
                const changelog = fs.readFileSync(changelogPath, 'utf8');

                // Extract version notes
                const versionMatch = changelog.match(/## \[([^\]]+)\][\s\S]*?(?=##|$)/);
                if (versionMatch) {
                    return versionMatch[0].replace(/## \[[^\]]+\][\s\S]*?\n/, '').trim();
                }
            }
        } catch (error) {
            log.warn('Failed to read CHANGELOG.md:', error);
        }

        // Fallback release notes
        return '• Cải thiện hiệu suất và ổn định\n• Sửa lỗi crash và memory leak\n• Cập nhật giao diện người dùng\n• Thêm tính năng auto-update';
    };

    handleUpdate = (): void => {
        downloadsManager.removeUpdateBeforeRestart();

        // Show dialog xác nhận trước khi update
        const releaseNotes = this.getReleaseNotes();
        dialog.showMessageBox({
            title: app.name,
            message: `Đã có bản cập nhật mới (${this.versionDownloaded}). Ứng dụng sẽ khởi động lại để hoàn tất việc cập nhật.`,
            detail: releaseNotes ? `Những thay đổi trong phiên bản mới:\n\n${releaseNotes}` : '',
            type: 'info',
            buttons: ['Cài đặt ngay', 'Bỏ qua'],
            defaultId: 0,
            cancelId: 1,
        }).then((result) => {
            if (result.response === 0) {
                // User chọn Install Now
                autoUpdater.quitAndInstall(true, true);
            }
        });
    };

    displayNoUpgrade = (): void => {
        const version = app.getVersion();
        ipcMain.emit(NO_UPDATE_AVAILABLE);
        dialog.showMessageBox({
            title: app.name,
            icon: appIcon,
            message: localizeMessage('main.autoUpdater.noUpdate.message', 'You\'re up to date'),
            type: 'info',
            buttons: [localizeMessage('label.ok', 'OK')],
            detail: localizeMessage('main.autoUpdater.noUpdate.detail', 'You are using the latest version of the {appName} Desktop App (version {version}). You\'ll be notified when a new version is available to install.', {appName: app.name, version}),
        });
    };

    checkForUpdates = (manually: boolean): void => {
        if (!Config.canUpgrade) {
            log.info('auto updates are disabled');
            return;
        }
        if (this.lastCheck) {
            clearTimeout(this.lastCheck);
        }
        if (!this.lastNotification || manually) {
            if (manually) {
                autoUpdater.once('update-not-available', this.displayNoUpgrade);
            }
            autoUpdater.checkForUpdates().then((result) => {
                if (!result?.updateInfo) {
                    ipcMain.emit(NO_UPDATE_AVAILABLE);
                }
            }).catch((reason) => {
                ipcMain.emit(NO_UPDATE_AVAILABLE);
                log.error('Failed to check for updates:', reason);
            });
            this.lastCheck = setTimeout(() => this.checkForUpdates(false), NEXT_CHECK);
        }
    };
}

const updateManager = new UpdateManager();
export default updateManager;
