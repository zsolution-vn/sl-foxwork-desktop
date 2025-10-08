// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import type {BrowserWindow, Rectangle} from 'electron';
import {app, Menu, session, dialog, nativeImage, screen, net} from 'electron';
import isDev from 'electron-is-dev';

import MainWindow from 'app/mainWindow/mainWindow';
import {createMenu as createAppMenu} from 'app/menus/app';
import {createMenu as createTrayMenu} from 'app/menus/tray';
import NavigationManager from 'app/navigationManager';
import Tray from 'app/system/tray/tray';
import WebContentsManager from 'app/views/webContentsManager';
import {MAIN_WINDOW_CREATED} from 'common/communication';
import Config from 'common/config';
import {SECURE_STORAGE_KEYS} from 'common/constants/secureStorage';
import JsonFileManager from 'common/JsonFileManager';
import {Logger} from 'common/log';
import type {MattermostServer} from 'common/servers/MattermostServer';
import ServerManager from 'common/servers/serverManager';
import {isValidURI, parseURL} from 'common/utils/url';
import updateManager from 'main/autoUpdater';
import {migrationInfoPath, updatePaths} from 'main/constants';
import {localizeMessage} from 'main/i18nManager';
import secureStorage from 'main/secureStorage';
import {getServerAPI} from 'main/server/serverAPI';
import {ServerInfo} from 'main/server/serverInfo';

import type {MigrationInfo} from 'types/config';
import type {RemoteInfo} from 'types/server';
import type {Boundaries} from 'types/utils';

import {mainProtocol} from './initialize';

const assetsDir = path.resolve(app.getAppPath(), 'assets');
const appIconURL = path.resolve(assetsDir, 'appicon_with_spacing_32.png');
const appIcon = nativeImage.createFromPath(appIconURL);
const log = new Logger('App.Utils');

export function openDeepLink(deeplinkingUrl: string) {
    try {
        log.info('openDeepLink invoked', {deeplinkingUrl});

        // Attempt desktop_token login handshake if deeplink is for desktop login
        try {
            const server = ServerManager.lookupServerByURL(deeplinkingUrl, true);
            // eslint-disable-next-line no-negated-condition
            if (!(server && server.isLoggedIn)) {
                tryDesktopTokenLogin(deeplinkingUrl);
            } else {
                log.info('Skipping desktop_token login: server already logged in', {serverId: server.id});
            }
        } catch (e) {
            // If lookup fails, fallback to attempting login
            tryDesktopTokenLogin(deeplinkingUrl);
        }

        if (MainWindow.get()) {
            MainWindow.show();
            NavigationManager.openLinkInPrimaryTab(deeplinkingUrl);
        } else {
            MainWindow.on(MAIN_WINDOW_CREATED, () => NavigationManager.openLinkInPrimaryTab(deeplinkingUrl));
        }
    } catch (err) {
        log.error(`There was an error opening the deeplinking url: ${err}`);
    }
}

async function tryDesktopTokenLogin(rawDeepLink: string) {
    try {
        // Expecting: foxwork://work.foxia.vn/login/desktop/?client_token=...&server_token=...
        const url = new URL(rawDeepLink);
        const host = url.host.toLowerCase();
        const pathname = url.pathname.toLowerCase();
        const serverToken = url.searchParams.get('server_token');
        const clientToken = url.searchParams.get('client_token');
        log.info('tryDesktopTokenLogin inspect', {scheme: url.protocol, host, pathname, hasServerToken: Boolean(serverToken), hasClientToken: Boolean(clientToken)});

        // Checklist: must target production host, correct path, and have server_token
        if (host !== 'work.foxia.vn' || !pathname.startsWith('/login/desktop') || !serverToken) {
            return;
        }
        log.info('desktop_token login', {serverToken});
        const endpoint = new URL('/api/v4/users/login/desktop_token', 'https://work.foxia.vn');

        const request = net.request({
            method: 'POST',
            url: endpoint.toString(),
            session: session.defaultSession,
            useSessionCookies: true,
        });

        request.setHeader('Content-Type', 'application/json');

        request.on('response', (response) => {
            const status = response.statusCode || 0;
            let raw = '';
            response.on('data', (chunk: Buffer) => {
                raw += `${chunk}`;
            });
            response.on('end', () => {
                try {
                    const body = raw ? JSON.parse(raw) as {server_error_id?: string; [k: string]: unknown} : {};
                    if (status >= 200 && status < 300) {
                        log.info('desktop_token login success');
                        validateDesktopLogin();
                    } else {
                        log.warn('desktop_token login failed', {status, server_error_id: (body as any)?.server_error_id, body});
                        const mw = MainWindow.get();
                        if (mw) {
                            dialog.showMessageBox(mw, {
                                type: 'error',
                                title: app.name,
                                message: 'Đăng nhập  thất bại',
                                detail: body?.message as any ?? 'Unknown error',
                                buttons: ['OK'],
                            });
                        }
                    }
                } catch (e) {
                    if (status >= 200 && status < 300) {
                        log.info('desktop_token login success (no body)');
                        const mw = MainWindow.get();
                        if (mw) {
                            dialog.showMessageBox(mw, {
                                type: 'info',
                                title: app.name,
                                message: 'Đăng nhập desktop_token thành công',
                                buttons: ['OK'],
                            });
                        }
                        validateDesktopLogin();
                    } else {
                        log.warn('desktop_token login failed (non-JSON body)', {status, raw});
                        const mw = MainWindow.get();
                        if (mw) {
                            dialog.showMessageBox(mw, {
                                type: 'error',
                                title: app.name,
                                message: 'Đăng nhập desktop_token thất bại',
                                buttons: ['OK'],
                            });
                        }
                    }
                }
            });
            response.on('error', (e) => {
                log.warn('desktop_token login response error', e);
            });
        });

        request.on('error', (e) => {
            log.warn('desktop_token login request error', e);
            const mw = MainWindow.get();
            if (mw) {
                dialog.showMessageBox(mw, {
                    type: 'error',
                    title: app.name,
                    message: 'Đăng nhập desktop_token thất bại',
                    detail: `Lỗi request tới /api/v4/users/login/desktop_token: ${e}`,
                    buttons: ['OK'],
                });
            }
        });

        const deviceId = await getOrCreateDeviceId('https://work.foxia.vn');
        const payload = JSON.stringify({token: serverToken, device_id: deviceId});
        request.write(payload);
        request.end();
    } catch (e) {
        // Swallow errors to not block normal deeplink navigation
        log.debug('tryDesktopTokenLogin skipped', e);
    }
}

function validateDesktopLogin() {
    try {
        const serverURL = parseURL('https://work.foxia.vn');
        if (!serverURL) {
            return;
        }
        const url = new URL('/api/v4/users/me', serverURL);

        getServerAPI(
            url,
            true,
            () => {
                const server = ServerManager.lookupServerByURL(serverURL);
                if (server) {
                    ServerManager.setLoggedIn(server.id, true);

                    // Refresh remote info (config/license/plugins) to update app state
                    updateServerInfos([server]);
                }

                // Thay vì relaunch toàn bộ app, chỉ reload như Cmd+R
                // Reload tất cả BrowserView sau khi đăng nhập thành công
                try {
                    WebContentsManager.reloadAllViews();
                } catch (e) {
                    log.debug('reloadAllViews failed', e);
                }
            },
            undefined,
            (error, statusCode) => {
                log.warn('validateDesktopLogin failed', {statusCode, error});

                const mw = MainWindow.get();
                if (mw) {
                    dialog.showMessageBox(mw, {
                        type: 'error',
                        title: app.name,
                        message: 'Đăng nhập desktop thất bại',
                        detail: `Kiểm tra /api/v4/users/me thất bại. status=${statusCode ?? ''}`,
                        buttons: ['OK'],
                    });
                }
            },
        );
    } catch (e) {
        log.debug('validateDesktopLogin skipped', e);
    }
}

async function getOrCreateDeviceId(serverUrlString: string): Promise<string> {
    const serverURL = parseURL(serverUrlString);
    const key = serverURL ? serverURL.toString() : serverUrlString;
    try {
        const existing = await secureStorage.getSecret(key, SECURE_STORAGE_KEYS.DEVICE_ID);
        if (existing) {
            return existing;
        }
    } catch (e) {
        log.debug('getOrCreateDeviceId read failed, will create new', e);
    }

    const newId = crypto.randomUUID();
    try {
        await secureStorage.setSecret(key, SECURE_STORAGE_KEYS.DEVICE_ID, newId);
    } catch (e) {
        log.debug('getOrCreateDeviceId write failed, continuing with volatile id', e);
    }
    return newId;
}

export function updateSpellCheckerLocales() {
    if (Config.spellCheckerLocales.length && app.isReady()) {
        session.defaultSession.setSpellCheckerLanguages(Config.spellCheckerLocales);
    }
}

export function handleUpdateMenuEvent() {
    log.debug('handleUpdateMenuEvent');

    const aMenu = createAppMenu(Config, updateManager);
    Menu.setApplicationMenu(aMenu);

    // set up context menu for tray icon
    if (shouldShowTrayIcon()) {
        const tMenu = createTrayMenu();
        Tray.setMenu(tMenu);
    }
}

export function getDeeplinkingURL(args: string[]) {
    if (Array.isArray(args) && args.length) {
    // deeplink urls should always be the last argument, but may not be the first (i.e. Windows with the app already running)
        const url = args[args.length - 1];
        const devAcceptedProtocols = ['mattermost-dev', mainProtocol].filter(Boolean) as string[];
        const protocolCandidates = isDev ? devAcceptedProtocols : [mainProtocol].filter(Boolean) as string[];
        if (url && protocolCandidates.some((p) => url.startsWith(p)) && isValidURI(url)) {
            return url;
        }
    }
    return undefined;
}

export function shouldShowTrayIcon() {
    return Config.showTrayIcon || process.platform === 'win32';
}

export function wasUpdated(lastAppVersion?: string) {
    return lastAppVersion !== app.getVersion();
}

export function clearAppCache() {
    // TODO: clear cache on browserviews, not in the renderer.
    const mainWindow = MainWindow.get();
    if (mainWindow) {
        mainWindow.webContents.session.clearCache().
            then(mainWindow.webContents.reload).
            catch((err) => {
                log.error('clearAppCache', err);
            });
    } else {
    //Wait for mainWindow
        setTimeout(clearAppCache, 100);
    }
}

function isWithinDisplay(state: Rectangle, display: Boundaries) {
    const startsWithinDisplay = !(state.x > display.maxX || state.y > display.maxY || state.x < display.minX || state.y < display.minY);
    if (!startsWithinDisplay) {
        return false;
    }

    // is half the screen within the display?
    const midX = state.x + (state.width / 2);
    const midY = state.y + (state.height / 2);
    return !(midX > display.maxX || midY > display.maxY);
}

function getDisplayBoundaries() {
    const displays = screen.getAllDisplays();

    return displays.map((display) => {
        return {
            maxX: display.workArea.x + display.workArea.width,
            maxY: display.workArea.y + display.workArea.height,
            minX: display.workArea.x,
            minY: display.workArea.y,
            maxWidth: display.workArea.width,
            maxHeight: display.workArea.height,
        };
    });
}

function getValidWindowPosition(state: Rectangle) {
    // Check if the previous position is out of the viewable area
    // (e.g. because the screen has been plugged off)
    const boundaries = getDisplayBoundaries();
    const display = boundaries.find((boundary) => {
        return isWithinDisplay(state, boundary);
    });

    if (typeof display === 'undefined') {
        return {};
    }
    return {x: state.x, y: state.y};
}

function getNewWindowPosition(browserWindow: BrowserWindow) {
    const mainWindow = MainWindow.get();
    if (!mainWindow) {
        return browserWindow.getPosition();
    }

    const newWindowSize = browserWindow.getSize();
    const mainWindowSize = mainWindow.getSize();
    const mainWindowPosition = mainWindow.getPosition();

    return [
        Math.floor(mainWindowPosition[0] + ((mainWindowSize[0] - newWindowSize[0]) / 2)),
        Math.floor(mainWindowPosition[1] + ((mainWindowSize[1] - newWindowSize[1]) / 2)),
    ];
}

export function resizeScreen(browserWindow: BrowserWindow) {
    const position = getNewWindowPosition(browserWindow);
    const size = browserWindow.getSize();
    const validPosition = getValidWindowPosition({
        x: position[0],
        y: position[1],
        width: size[0],
        height: size[1],
    });
    if (typeof validPosition.x !== 'undefined' || typeof validPosition.y !== 'undefined') {
        browserWindow.setPosition(validPosition.x || 0, validPosition.y || 0);
    } else {
        browserWindow.center();
    }
}

export function flushCookiesStore() {
    log.debug('flushCookiesStore');
    session.defaultSession.cookies.flushStore().catch((err) => {
        log.error(`There was a problem flushing cookies:\n${err}`);
    });
}

export function migrateMacAppStore() {
    const migrationPrefs = new JsonFileManager<MigrationInfo>(migrationInfoPath);
    const oldPath = path.join(app.getPath('userData'), '../../../../../../../Library/Application Support/Mattermost');

    // Check if we've already migrated
    if (migrationPrefs.getValue('masConfigs')) {
        return;
    }

    // Check if the files are there to migrate
    try {
        const exists = fs.existsSync(oldPath);
        if (!exists) {
            log.info('MAS: No files to migrate, skipping');
            return;
        }
    } catch (e) {
        log.error('MAS: Failed to check for existing Mattermost Desktop install, skipping', e);
        return;
    }

    const cancelImport = dialog.showMessageBoxSync({
        title: app.name,
        message: localizeMessage('main.app.utils.migrateMacAppStore.dialog.message', 'Import Existing Configuration'),
        detail: localizeMessage('main.app.utils.migrateMacAppStore.dialog.detail', 'It appears that an existing {appName} configuration exists, would you like to import it? You will be asked to pick the correct configuration directory.', {appName: app.name}),
        icon: appIcon,
        buttons: [
            localizeMessage('main.app.utils.migrateMacAppStore.button.selectAndImport', 'Select Directory and Import'),
            localizeMessage('main.app.utils.migrateMacAppStore.button.dontImport', 'Don\'t Import'),
        ],
        type: 'info',
        defaultId: 0,
        cancelId: 1,
    });

    if (cancelImport) {
        migrationPrefs.setValue('masConfigs', true);
        return;
    }

    const result = dialog.showOpenDialogSync({
        defaultPath: oldPath,
        properties: ['openDirectory'],
    });
    if (!(result && result[0])) {
        return;
    }

    try {
        fs.cpSync(result[0], app.getPath('userData'), {recursive: true});
        updatePaths(true);
        migrationPrefs.setValue('masConfigs', true);
    } catch (e) {
        log.error('MAS: An error occurred importing the existing configuration', e);
    }
}

export async function updateServerInfos(servers: MattermostServer[]) {
    const map: Map<string, RemoteInfo> = new Map();
    await Promise.all(servers.map((srv) => {
        const serverInfo = new ServerInfo(srv);
        return serverInfo.fetchRemoteInfo().
            then((data) => {
                map.set(srv.id, data);
            }).
            catch((error) => {
                log.warn('Could not get server info for', srv.name, error);
            });
    }));
    map.forEach((serverInfo, serverId) => {
        ServerManager.updateRemoteInfo(serverId, serverInfo);
    });
}

export async function clearDataForServer(server: MattermostServer) {
    const mainWindow = MainWindow.get();
    if (!mainWindow) {
        return;
    }

    const response = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: [
            localizeMessage('main.app.utils.clearDataForServer.confirm', 'Clear Data'),
            localizeMessage('main.app.utils.clearDataForServer.cancel', 'Cancel'),
        ],
        defaultId: 1,
        message: localizeMessage('main.app.utils.clearDataForServer.message', 'This action will erase all session, cache, cookie and storage data for the server "{serverName}". Are you sure you want to clear data for this server?', {serverName: server.name}),
    });

    if (response.response === 0) {
        await session.defaultSession.clearData({
            origins: [server.url.origin],
        });

        ServerManager.reloadServer(server.id);
    }
}

export async function clearAllData() {
    const mainWindow = MainWindow.get();
    if (!mainWindow) {
        return;
    }

    const response = await dialog.showMessageBox(mainWindow, {
        title: app.name,
        type: 'warning',
        buttons: [
            localizeMessage('main.app.utils.clearAllData.confirm', 'Clear All Data'),
            localizeMessage('main.app.utils.clearAllData.cancel', 'Cancel'),
        ],
        defaultId: 1,
        message: localizeMessage('main.app.utils.clearAllData.message', 'This action will erase all session, cache, cookie and storage data for all server. Performing this action will restart the application. Are you sure you want to clear all data?'),
    });

    if (response.response === 0) {
        await session.defaultSession.clearAuthCache();
        await session.defaultSession.clearCodeCaches({});
        await session.defaultSession.clearHostResolverCache();
        await session.defaultSession.clearData();
        app.relaunch();
        app.exit();
    }
}
