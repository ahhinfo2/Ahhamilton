# AHH Hamilton — Application de bureau Windows

Application Electron qui emballe le tableau de bord AHH dans une fenêtre Windows native.

## Fonctionnalités

- Fenêtre Windows native avec icône AHH dans la barre des tâches
- Icône dans la zone de notification (barre système)
- Menu avec raccourcis : Tableau de bord, Site public, Scanners
- Zoom (+/-/100%)
- Liens externes ouverts dans le navigateur par défaut
- Réduction dans la barre système (ne ferme pas l'app)
- Instance unique (pas de doublons)

## Installation

### Prérequis
- Node.js 18+ installé
- Connexion internet (l'app se connecte à ahhamilton.ca)

### Développement (tester)
```bash
cd desktop-app
npm install
npm start
```

### Construire l'installateur Windows (.exe)
```bash
cd desktop-app
npm install
npm run build
```
L'installateur sera dans `desktop-app/dist/`.

### Version portable (sans installation)
```bash
npm run build-portable
```
Génère un fichier `AHH-Hamilton-Portable.exe` qui fonctionne sans installation.

## Raccourcis clavier

| Raccourci | Action |
|---|---|
| F5 | Rafraîchir |
| Ctrl+= | Zoom + |
| Ctrl+- | Zoom - |
| Ctrl+0 | Zoom 100% |
| Alt+← | Page précédente |
| Alt+→ | Page suivante |
| Alt+F4 | Quitter |
