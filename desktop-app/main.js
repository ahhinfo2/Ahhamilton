const electron = require('electron');
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;
const Menu = electron.Menu;
const Tray = electron.Tray;
const shell = electron.shell;
const path = require('path');

const SITE_URL = 'https://ahhamilton.ca';
const DASHBOARD_URL = SITE_URL + '/dashboard/app.html';

let mainWindow = null;
let tray = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {

app.on('second-instance', function() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('ready', function() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'AHH Hamilton',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadURL(DASHBOARD_URL);

  // Liens externes dans le navigateur
  mainWindow.webContents.setWindowOpenHandler(function(details) {
    if (details.url.startsWith('http') && details.url.indexOf('ahhamilton.ca') === -1) {
      shell.openExternal(details.url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Réduire dans la barre système
  mainWindow.on('close', function(event) {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // Menu
  var menu = Menu.buildFromTemplate([
    {
      label: 'AHH Hamilton',
      submenu: [
        { label: 'Tableau de bord', click: function() { mainWindow.loadURL(DASHBOARD_URL); } },
        { label: 'Site public', click: function() { mainWindow.loadURL(SITE_URL); } },
        { type: 'separator' },
        { label: 'Numériser billets', click: function() { mainWindow.loadURL(SITE_URL + '/scan.html'); } },
        { type: 'separator' },
        { label: 'Rafraîchir', accelerator: 'F5', click: function() { mainWindow.reload(); } },
        { label: 'Zoom +', accelerator: 'CmdOrCtrl+=', click: function() { mainWindow.webContents.setZoomLevel(mainWindow.webContents.getZoomLevel() + 0.5); } },
        { label: 'Zoom -', accelerator: 'CmdOrCtrl+-', click: function() { mainWindow.webContents.setZoomLevel(mainWindow.webContents.getZoomLevel() - 0.5); } },
        { label: 'Zoom 100%', accelerator: 'CmdOrCtrl+0', click: function() { mainWindow.webContents.setZoomLevel(0); } },
        { type: 'separator' },
        { label: 'Quitter', accelerator: 'Alt+F4', click: function() { app.isQuitting = true; app.quit(); } }
      ]
    },
    {
      label: 'Navigation',
      submenu: [
        { label: 'Retour', accelerator: 'Alt+Left', click: function() { mainWindow.webContents.goBack(); } },
        { label: 'Avancer', accelerator: 'Alt+Right', click: function() { mainWindow.webContents.goForward(); } },
        { label: 'Accueil', click: function() { mainWindow.loadURL(DASHBOARD_URL); } }
      ]
    }
  ]);
  Menu.setApplicationMenu(menu);

  // Barre système
  try {
    tray = new Tray(path.join(__dirname, 'icon.png'));
    tray.setToolTip('AHH Hamilton');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Ouvrir', click: function() { mainWindow.show(); mainWindow.focus(); } },
      { label: 'Quitter', click: function() { app.isQuitting = true; app.quit(); } }
    ]));
    tray.on('click', function() { mainWindow.show(); mainWindow.focus(); });
  } catch(e) {}
});

app.on('window-all-closed', function() { app.quit(); });

} // fin du else de requestSingleInstanceLock
