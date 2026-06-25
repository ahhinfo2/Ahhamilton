/**
 * useHeroAnimation
 * ─────────────────────────────────────────────────────────────────────
 * Hook personnalisé qui gère les animations d'entrée du Hero.
 * Sépare la logique d'animation du rendu visuel (principe de séparation
 * des responsabilités recommandé par le skill react-expert).
 *
 * Animations produites :
 *  - fadeAnim   : opacité 0 → 1 (conteneur global)
 *  - slideAnim  : translation Y +40 → 0 (textes)
 *  - scaleAnim  : scale 0.92 → 1 (bouton CTA)
 */

import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';

// ── Types ──────────────────────────────────────────────────────────────

export interface HeroAnimations {
  /** Valeur animée pour l'opacité du conteneur global */
  fadeAnim:  Animated.Value;
  /** Valeur animée pour la translation verticale des textes */
  slideAnim: Animated.Value;
  /** Valeur animée pour le scale du bouton CTA */
  scaleAnim: Animated.Value;
}

// ── Hook ───────────────────────────────────────────────────────────────

export function useHeroAnimation(): HeroAnimations {
  // Valeurs initiales : invisible, décalé vers le bas, légèrement réduit
  const fadeAnim  = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(40)).current;
  const scaleAnim = useRef(new Animated.Value(0.92)).current;

  useEffect(() => {
    // Séquence d'animations en parallèle avec léger décalage
    Animated.sequence([
      // Petite pause initiale pour laisser le fond se charger
      Animated.delay(120),

      Animated.parallel([
        // 1. Fondu d'entrée du conteneur
        Animated.timing(fadeAnim, {
          toValue:         1,
          duration:        700,
          easing:          Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        // 2. Remontée des textes (slide-up)
        Animated.timing(slideAnim, {
          toValue:         0,
          duration:        650,
          easing:          Easing.out(Easing.back(1.4)),
          useNativeDriver: true,
        }),
        // 3. Scale du bouton avec léger décalage (apparaît en dernier)
        Animated.sequence([
          Animated.delay(200),
          Animated.spring(scaleAnim, {
            toValue:         1,
            tension:         60,
            friction:        8,
            useNativeDriver: true,
          }),
        ]),
      ]),
    ]).start();

    // Pas de cleanup nécessaire : les Animated.Value sont ref-stables
  }, [fadeAnim, slideAnim, scaleAnim]);

  return { fadeAnim, slideAnim, scaleAnim };
}
