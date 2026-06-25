/** @type {import('tailwindcss').Config} */
module.exports = {
  // Chemins à scanner pour purger les classes inutilisées en production
  content: [
    './App.{js,ts,jsx,tsx}',
    './components/**/*.{js,ts,jsx,tsx}',
    './screens/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      // Palette AHH — cohérente avec style.css du site web
      colors: {
        ahh: {
          green:      '#1b5e20', // --g1
          'green-md': '#2e7d32', // --g2
          'green-lt': '#43a047', // --g3
          gold:       '#f9a825', // --accent
          'gold-lt':  '#fdd835', // --accent-lt
          blue:       '#003F87', // --hai-blue
          red:        '#D21034', // --hai-red
          text:       '#1a2e1a',
          muted:      '#607060',
        },
      },
      fontFamily: {
        // Expo gère ses propres polices ; on garde des alias lisibles
        sans:  ['System'],
        serif: ['System'],
      },
      borderRadius: {
        '2xl': '20px',
        '3xl': '28px',
      },
    },
  },
  plugins: [],
};
