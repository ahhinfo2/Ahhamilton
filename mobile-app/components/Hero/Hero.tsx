/**
 * Composant Hero — AHH Hamilton (React Native + NativeWind)
 * ─────────────────────────────────────────────────────────────────────
 * Section héro réutilisable pour la page d'accueil de l'app mobile.
 *
 * Fonctionnalités :
 *  ✅ Titre principal + sous-titre
 *  ✅ Bouton CTA principal + secondaire (optionnel)
 *  ✅ Image d'arrière-plan ou dégradé de couleurs
 *  ✅ Responsive mobile-first (SafeAreaView + dimensions dynamiques)
 *  ✅ Animations d'entrée fluides (useHeroAnimation)
 *  ✅ Styles Tailwind via NativeWind
 *  ✅ Accessibilité (accessibilityLabel, accessibilityRole)
 *  ✅ React.memo pour éviter les re-renders inutiles
 *  ✅ TypeScript strict
 */

import React, { memo } from 'react';
import {
  View,
  Text,
  ImageBackground,
  TouchableOpacity,
  Animated,
  Dimensions,
  StatusBar,
  Platform,
  type ImageSourcePropType,
  type GestureResponderEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { styled } from 'nativewind';
import { useHeroAnimation } from './useHeroAnimation';

// ── Composants stylisés NativeWind ────────────────────────────────────
// `styled()` permet d'utiliser la prop `className` avec les classes Tailwind

const StyledView             = styled(View);
const StyledText             = styled(Text);
const StyledTouchable        = styled(TouchableOpacity);
const StyledAnimatedView     = styled(Animated.View);
const StyledImageBackground  = styled(ImageBackground);
const StyledSafeAreaView     = styled(SafeAreaView);

// ── Types ──────────────────────────────────────────────────────────────

/** Configuration du bouton CTA */
interface CtaButton {
  /** Texte affiché sur le bouton */
  label:    string;
  /** Callback déclenché au tap */
  onPress:  (event: GestureResponderEvent) => void;
  /** Icône/emoji optionnel affiché avant le label */
  icon?:    string;
}

/** Props du composant Hero */
export interface HeroProps {
  /** Titre principal (ligne 1) */
  title: string;
  /** Mise en évidence d'un mot dans le titre (affiché en doré) */
  titleHighlight?: string;
  /** Sous-titre descriptif */
  subtitle: string;
  /** Badge affiché au-dessus du titre (ex : "Communauté · Hamilton") */
  badge?: string;
  /** Bouton CTA principal (obligatoire) */
  cta: CtaButton;
  /** Bouton CTA secondaire (optionnel) */
  ctaSecondary?: CtaButton;
  /** Source d'image d'arrière-plan (require() ou { uri: '...' }) */
  backgroundImage?: ImageSourcePropType;
  /** Afficher les statistiques rapides sous les boutons */
  stats?: Array<{ value: string; label: string }>;
}

// ── Constantes ─────────────────────────────────────────────────────────

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

// Hauteur minimale du Hero = hauteur d'écran complète
const HERO_MIN_HEIGHT = SCREEN_HEIGHT;

// ── Sous-composant : Badge ─────────────────────────────────────────────

const HeroBadge = memo(({ text }: { text: string }) => (
  <StyledView
    className="flex-row items-center self-center mb-5 px-4 py-1.5
               rounded-full border border-white/25 bg-white/10"
    accessibilityRole="text"
  >
    {/* Point décoratif vert */}
    <StyledView className="w-1.5 h-1.5 rounded-full bg-ahh-gold mr-2" />
    <StyledText className="text-white/90 text-xs font-bold tracking-widest uppercase">
      {text}
    </StyledText>
  </StyledView>
));
HeroBadge.displayName = 'HeroBadge';

// ── Sous-composant : Titre ─────────────────────────────────────────────

const HeroTitle = memo(({
  title,
  highlight,
}: {
  title:     string;
  highlight?: string;
}) => {
  // Découpe le titre pour mettre en évidence le mot spécifié
  if (!highlight || !title.includes(highlight)) {
    return (
      <StyledText
        className="text-white text-center font-bold mb-3"
        style={{ fontSize: 34, lineHeight: 42 }}
        accessibilityRole="header"
      >
        {title}
      </StyledText>
    );
  }

  const [before, after] = title.split(highlight);
  return (
    <StyledText
      className="text-white text-center font-bold mb-3"
      style={{ fontSize: 34, lineHeight: 42 }}
      accessibilityRole="header"
    >
      {before}
      {/* Mot mis en évidence : couleur dorée AHH */}
      <StyledText className="text-ahh-gold italic">{highlight}</StyledText>
      {after}
    </StyledText>
  );
});
HeroTitle.displayName = 'HeroTitle';

// ── Sous-composant : Bouton CTA principal ──────────────────────────────

const HeroCtaPrimary = memo(({
  label,
  icon,
  onPress,
  scaleAnim,
}: CtaButton & { scaleAnim: Animated.Value }) => (
  <StyledAnimatedView
    style={{ transform: [{ scale: scaleAnim }] }}
    className="w-full"
  >
    <StyledTouchable
      className="flex-row items-center justify-center px-8 py-4
                 rounded-full bg-ahh-gold active:opacity-80 w-full"
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      // Retour haptique visuel
      activeOpacity={0.82}
    >
      {icon && (
        <StyledText className="text-xl mr-2" accessibilityElementsHidden>
          {icon}
        </StyledText>
      )}
      <StyledText
        className="text-ahh-text text-base font-bold tracking-wide"
      >
        {label}
      </StyledText>
    </StyledTouchable>
  </StyledAnimatedView>
));
HeroCtaPrimary.displayName = 'HeroCtaPrimary';

// ── Sous-composant : Bouton CTA secondaire (ghost) ─────────────────────

const HeroCtaSecondary = memo(({ label, icon, onPress }: CtaButton) => (
  <StyledTouchable
    className="flex-row items-center justify-center px-8 py-4 mt-3
               rounded-full border-2 border-white/40 bg-white/10 w-full"
    onPress={onPress}
    accessibilityRole="button"
    accessibilityLabel={label}
    activeOpacity={0.75}
  >
    {icon && (
      <StyledText className="text-xl mr-2" accessibilityElementsHidden>
        {icon}
      </StyledText>
    )}
    <StyledText className="text-white text-base font-semibold">
      {label}
    </StyledText>
  </StyledTouchable>
));
HeroCtaSecondary.displayName = 'HeroCtaSecondary';

// ── Sous-composant : Statistiques ──────────────────────────────────────

const HeroStats = memo(({
  stats,
}: {
  stats: Array<{ value: string; label: string }>;
}) => (
  <StyledView
    className="flex-row justify-center flex-wrap gap-3 mt-8"
    accessibilityRole="summary"
    accessibilityLabel="Statistiques de la communauté"
  >
    {stats.map((stat, index) => (
      <StyledView
        key={index}
        className="items-center px-5 py-3 rounded-2xl
                   bg-white/10 border border-white/20 min-w-[90px]"
      >
        <StyledText className="text-ahh-gold text-2xl font-black">
          {stat.value}
        </StyledText>
        <StyledText className="text-white/70 text-xs font-semibold uppercase tracking-wider mt-0.5">
          {stat.label}
        </StyledText>
      </StyledView>
    ))}
  </StyledView>
));
HeroStats.displayName = 'HeroStats';

// ── Composant principal ────────────────────────────────────────────────

function Hero({
  title,
  titleHighlight,
  subtitle,
  badge,
  cta,
  ctaSecondary,
  backgroundImage,
  stats,
}: HeroProps) {
  // Animations d'entrée (logique isolée dans le hook)
  const { fadeAnim, slideAnim, scaleAnim } = useHeroAnimation();

  // Hauteur de la barre de statut (iOS/Android)
  const statusBarHeight =
    Platform.OS === 'android' ? (StatusBar.currentHeight ?? 24) : 44;

  // ── Rendu ────────────────────────────────────────────────────────────

  const content = (
    <StyledSafeAreaView className="flex-1">

      {/* Barre de statut transparente pour immersion totale */}
      <StatusBar
        translucent
        backgroundColor="transparent"
        barStyle="light-content"
      />

      {/* Contenu animé — fondu + slide-up */}
      <StyledAnimatedView
        className="flex-1 items-center justify-center px-6"
        style={{
          paddingTop:    statusBarHeight + 20,
          paddingBottom: 48,
          opacity:       fadeAnim,
          transform:     [{ translateY: slideAnim }],
        }}
      >
        {/* ── Badge optionnel ── */}
        {badge && <HeroBadge text={badge} />}

        {/* ── Titre principal ── */}
        <HeroTitle title={title} highlight={titleHighlight} />

        {/* ── Sous-titre ── */}
        <StyledText
          className="text-white/80 text-center text-base leading-7 mb-8 max-w-xs"
        >
          {subtitle}
        </StyledText>

        {/* ── Boutons CTA ── */}
        <StyledView className="w-full max-w-xs">
          <HeroCtaPrimary
            label={cta.label}
            icon={cta.icon}
            onPress={cta.onPress}
            scaleAnim={scaleAnim}
          />
          {ctaSecondary && (
            <HeroCtaSecondary
              label={ctaSecondary.label}
              icon={ctaSecondary.icon}
              onPress={ctaSecondary.onPress}
            />
          )}
        </StyledView>

        {/* ── Statistiques optionnelles ── */}
        {stats && stats.length > 0 && <HeroStats stats={stats} />}

        {/* ── Indicateur de scroll (flèche vers le bas) ── */}
        <StyledView className="absolute bottom-8 items-center opacity-60">
          <StyledText className="text-white text-xs uppercase tracking-widest mb-1">
            Défiler
          </StyledText>
          {/* Chevron animé simple */}
          <StyledText className="text-white text-lg">↓</StyledText>
        </StyledView>

      </StyledAnimatedView>
    </StyledSafeAreaView>
  );

  // ── Avec image d'arrière-plan ─────────────────────────────────────

  if (backgroundImage) {
    return (
      <StyledImageBackground
        source={backgroundImage}
        className="flex-1"
        style={{ minHeight: HERO_MIN_HEIGHT }}
        resizeMode="cover"
        accessibilityIgnoresInvertColors // Préserve les couleurs de l'image
      >
        <LinearGradient
          colors={['rgba(10,30,10,0.85)', 'rgba(27,94,32,0.55)', 'rgba(10,30,10,0.80)']}
          locations={[0, 0.5, 1]}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        />

        {content}
      </StyledImageBackground>
    );
  }

  // ── Sans image : dégradé AHH (vert → bleu haïtien) ──────────────

  return (
    <StyledView
      className="flex-1"
      style={{
        minHeight:       HERO_MIN_HEIGHT,
        // Dégradé simulé par backgroundColor + overlay
        backgroundColor: '#1b5e20',
      }}
    >
      <LinearGradient
        colors={['#1b5e20', '#003F87', '#1b5e20']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />
      {content}
    </StyledView>
  );
}

// ── Export avec React.memo pour éviter les re-renders inutiles ─────────
// Le Hero est un composant "statique" : ses props changent rarement
export default memo(Hero);
