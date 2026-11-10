#!/usr/bin/env node

/**
 * Backup cleanup script - only runs in case of abnormal termination
 * This is a safety net for cases where the main cleanup mechanism fails
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Log to file for debugging
const logFile = path.join(os.tmpdir(), 'mrt-cleanup.log');

function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [cleanup-backup] ${message}\n`;
  
  try {
    fs.appendFileSync(logFile, logMessage, 'utf8');
  } catch (e) {
    // Ignore file write errors
  }
}

function killProcesses() {
  if (process.platform !== 'win32') {
    log('Not Windows, skipping cleanup');
    return;
  }

  log('Backup cleanup started (only runs if main cleanup failed)');

  try {
    // Kill mrt-ws-server.exe processes
    try {
      const output = execSync('tasklist /FI "IMAGENAME eq mrt-ws-server.exe" /FO CSV /NH', {
        encoding: 'utf8',
        timeout: 3000,
      });

      if (output.includes('mrt-ws-server.exe')) {
        log('Found orphaned mrt-ws-server.exe, killing...');
        const result = killWindowsProcessByImage('mrt-ws-server.exe');
        if (result.ok) {
          log('Killed orphaned mrt-ws-server.exe');
        } else if (result.status !== 128) {
          log(`taskkill returned status ${result.status} for mrt-ws-server.exe`);
        }
      } else {
        log('No orphaned mrt-ws-server.exe found (good!)');
      }
    } catch (e) {
      log('No mrt-ws-server.exe to clean');
    }

    // Kill python.exe processes running ws_server
    try {
      const pythonOutput = execSync('tasklist /FI "IMAGENAME eq python.exe" /FO CSV /NH', {
        encoding: 'utf8',
        timeout: 3000,
      });

      if (pythonOutput.includes('python.exe')) {
        try {
          const wmicOutput = execSync(
            'wmic process where "name=\'python.exe\'" get commandline,processid /format:csv',
            { encoding: 'utf8', timeout: 5000 }
          );

          const lines = wmicOutput.split('\n');
          let killedCount = 0;

          for (const line of lines) {
            if (line.includes('eye_tracking') || line.includes('mrt-ws-server') || line.includes('ws_server')) {
              const match = line.match(/,(\d+)\s*$/);
              if (match) {
                const pid = match[1];
                try {
                  const result = killWindowsProcessByPid(pid);
                  if (result.ok) {
                    log(`Killed orphaned Python server PID: ${pid}`);
                    killedCount++;
                  } else if (result.status !== 128) {
                    log(`Failed to kill PID ${pid}, status=${result.status}`);
                  }
                } catch (e) {
                  log(`Failed to kill PID ${pid}`);
                }
              }
            }
          }

          if (killedCount > 0) {
            log(`Cleaned up ${killedCount} orphaned Python process(es)`);
          } else {
            log('No orphaned Python processes found (good!)');
          }
        } catch (e) {
          log('Could not query Python processes');
        }
      } else {
        log('No Python processes found');
      }
    } catch (e) {
      log('No Python processes to check');
    }

    log('Backup cleanup completed');
  } catch (error) {
    log('Backup cleanup error: ' + error.message);
  }
}

function killWindowsProcessByPid(pid) {
  const pidValue = String(pid || '').trim();
  if (!pidValue) return { ok: false, status: null };
  const result = spawnSync('taskkill', ['/PID', pidValue, '/F', '/T'], {
    windowsHide: true,
    stdio: 'ignore',
    timeout: 3000,
  });
  return { ok: result.status === 0, status: result.status ?? null };
}

function killWindowsProcessByImage(imageName) {
  const nameValue = String(imageName || '').trim();
  if (!nameValue) return { ok: false, status: null };
  const result = spawnSync('taskkill', ['/IM', nameValue, '/F', '/T'], {
    windowsHide: true,
    stdio: 'ignore',
    timeout: 3000,
  });
  return { ok: result.status === 0, status: result.status ?? null };
}

// Wrap everything in try-catch
try {
  log('=== Backup cleanup script started ===');
  
  // Wait a bit to ensure main process has exited
  setTimeout(() => {
    try {
      killProcesses();
    } catch (e) {
      log('Fatal error: ' + e.message);
    } finally {
      log('=== Backup cleanup script exiting ===');
      process.exit(0);
    }
  }, 1000);
} catch (e) {
  log('Fatal error in cleanup script: ' + e.message);
  process.exit(1);
}
