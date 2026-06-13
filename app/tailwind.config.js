/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // DREAMREEL fixed palette — do not redesign.
        ink: '#0E0B08',
        amber: '#C8A35E', // tungsten amber
        lamp: '#E8C887', // lamp glow
        bone: '#D8D2C4', // silver-bone
        sepia: '#6B5640',
        verdigris: '#4A6B66',
      },
      fontFamily: {
        // Bodoni Moda — intertitles / title cards (caps, wide tracking)
        title: ['"Bodoni Moda"', 'serif'],
        // EB Garamond — drifting stream-of-consciousness text
        drift: ['"EB Garamond"', 'serif'],
        // Courier Prime — archival captions / metadata
        mono: ['"Courier Prime"', 'monospace'],
      },
      letterSpacing: {
        intertitle: '0.28em',
      },
      keyframes: {
        flicker: {
          '0%,100%': { opacity: '1' },
          '50%': { opacity: '0.86' },
        },
      },
      animation: {
        flicker: 'flicker 4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
