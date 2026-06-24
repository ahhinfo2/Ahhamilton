# AHH Hamilton — App Mobile

Application mobile React Native (Expo) pour l'Association Haïtienne de Hamilton.

## Prérequis

- Node.js 18+
- Expo CLI : `npm install -g expo-cli`
- EAS CLI (pour build) : `npm install -g eas-cli`
- Expo Go sur le téléphone (pour développement)

## Installation

```bash
cd mobile-app
npm install
```

## Développement

```bash
npm start
```

Scanner le QR code avec Expo Go sur votre téléphone.

## Build APK Android

```bash
# Créer un compte Expo : https://expo.dev
eas login
eas build --platform android --profile preview
```

## Build iOS

```bash
eas build --platform ios --profile preview
```

## Architecture

L'app utilise une WebView qui charge le site ahhamilton.ca avec :
- Barre de navigation native en bas (Accueil, Activités, Scanner, Courriel, Profil)
- Bouton Scanner central surélevé
- Notifications push via Expo
- Liens externes ouverts dans le navigateur
- Navbar/footer du site cachés (remplacés par la tab bar native)
- Splash screen vert avec logo AHH
- Back button Android → navigation arrière dans la WebView
