// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

let getFocusAssist: undefined | (() => {value: number});
let isPriority: undefined | ((appUserModelId: string) => {value: boolean});

try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const wfa = require('windows-focus-assist');
    getFocusAssist = wfa.getFocusAssist;
    isPriority = wfa.isPriority;
} catch (e) {
    // Module not available or failed to load; fall back to default behavior.
}

/**
    -2: NOT_SUPPORTED,
    -1: FAILED,
    0: Off,
    1: PRIORITY_ONLY,
    2: ALARMS_ONLY
*/
function getWindowsDoNotDisturb() {
    if (process.platform !== 'win32') {
        return false;
    }

    if (!getFocusAssist) {
        // If we can't read focus assist state, assume DND is off to avoid blocking notifications.
        return false;
    }

    const focusAssistValue = getFocusAssist().value;
    switch (focusAssistValue) {
    case 2:
        return true;
    case 1:
        // If isPriority checker is unavailable, treat as not priority to avoid suppressing unnecessarily
        if (!isPriority) {
            return false;
        }
        return !(isPriority('Mattermost.Desktop').value);
    default:
        return false;
    }
}

export default getWindowsDoNotDisturb;
