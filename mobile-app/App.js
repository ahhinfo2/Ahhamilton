import React, { useRef, useState, useEffect } from 'react';
import { StyleSheet, View, StatusBar, BackHandler, Platform, Alert, Linking, ActivityIndicator, Text, TouchableOpacity } from 'react-native';
import { WebView } from 'react-native-webview';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import * as Haptics from 'expo-haptics';
import Hero from './components/Hero';

const SITE_URL = 'https://ahhamilton.ca';
const DASHBOARD_URL = SITE_URL + '/dashboard/app.html';


Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: true }),
});

export default function App() {
  const webViewRef = useRef(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [loading, setLoading] = useState(true);
  const [currentUrl, setCurrentUrl] = useState(DASHBOARD_URL);
  const [activeTab, setActiveTab] = useState('home');
  const [showHero, setShowHero] = useState(true);
  const [stats, setStats] = useState([
    { value: '150+', label: 'Membres' },
    { value: '50+',  label: 'Activités' },
    { value: '17+',  label: 'Années' },
  ]);

  useEffect(() => {
    registerForPush();
    fetchStats();
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBack && webViewRef.current) { webViewRef.current.goBack(); return true; }
      return false;
    });
    return () => backHandler.remove();
  }, [canGoBack]);

  async function fetchStats() {
    try {
      const res = await fetch(SITE_URL + '/api/stats/public');
      const data = await res.json();
      setStats([
        { value: `${data.membres}+`, label: 'Membres' },
        { value: `${data.activites}+`, label: 'Activités' },
        { value: `${data.annees}+`, label: 'Années' },
      ]);
    } catch (e) {}
  }

  async function registerForPush() {
    if (!Device.isDevice) return;
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') return;
    const token = (await Notifications.getExpoPushTokenAsync()).data;
    console.log('Push token:', token);
  }

  function navigate(url, tab) {
    setActiveTab(tab);
    if (webViewRef.current) webViewRef.current.injectJavaScript(`window.location.href='${url}';true;`);
  }

  function onMessage(event) {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'auth-status') {
        setShowHero(!data.loggedIn);
      } else if (data.type === 'notification') {
        Notifications.scheduleNotificationAsync({
          content: { title: data.title || 'AHH', body: data.body || '', sound: true },
          trigger: null,
        });
      }
    } catch (e) {}
  }

  const injectedJS = `
    (function() {
      window.EXPO_PUSH_TOKEN = true;
      if (window.ReactNativeWebView) {
        // Signaler l'état d'authentification à React Native
        var token = localStorage.getItem('ahh_token');
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'auth-status',
          loggedIn: !!token
        }));

        // Intercepter logout pour signaler la déconnexion
        var origLogout = window.logout;
        window.logout = function() {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'auth-status', loggedIn: false
          }));
          if (origLogout) origLogout();
        };

        // Intercepter les notifications pour les pousser en natif
        var origToast = window.toast;
        if (origToast) {
          window.toast = function(msg, isError) {
            origToast(msg, isError);
            if (!isError) {
              window.ReactNativeWebView.postMessage(JSON.stringify({type:'notification', title:'AHH', body: msg}));
            }
          };
        }
      }
      // Cacher les éléments redondants en mode app
      var style = document.createElement('style');
      style.textContent = '.navbar{display:none!important}.footer{display:none!important}body{padding-top:0!important}';
      document.head.appendChild(style);
      true;
    })();
  `;

  return (
    <View style={styles.container}>
      <StatusBar backgroundColor="#1b5e20" barStyle="light-content" />

      {/* ── Hero natif (affiché avant connexion) ── */}
      {showHero && (
        <Hero
          badge="Communauté Haïtienne · Hamilton, ON"
          title="Notre communauté, unie et solidaire"
          titleHighlight="unie"
          subtitle="Rejoignez l'Association Haïtienne de Hamilton — culture, entraide et solidarité depuis 2008."
          backgroundImage={require('./assets/hero-bg.jpg')}
          cta={{
            label:   'Devenir membre',
            icon:    '🤝',
            onPress: () => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              setShowHero(false);
              navigate(SITE_URL + '/adhesion.html', 'home');
            },
          }}
          ctaSecondary={{
            label:   'Explorer le site',
            onPress: () => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setShowHero(false);
            },
          }}
          stats={stats}
        />
      )}

      {loading && !showHero && (
        <View style={styles.splash}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.splashText}>AHH Hamilton</Text>
          <Text style={styles.splashSub}>Chargement...</Text>
        </View>
      )}

      <WebView
        ref={webViewRef}
        source={{ uri: currentUrl }}
        style={styles.webview}
        onLoadEnd={() => setLoading(false)}
        onNavigationStateChange={(navState) => {
          setCanGoBack(navState.canGoBack);
          setCurrentUrl(navState.url);
          if (navState.url.includes('login.html')) setShowHero(true);
        }}
        onMessage={onMessage}
        injectedJavaScript={injectedJS}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        startInLoadingState={false}
        allowsBackForwardNavigationGestures={true}
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback={true}
        mediaCapturePermissionGrantType="grant"
        onShouldStartLoadWithRequest={(request) => {
          if (request.url.startsWith('mailto:') || request.url.startsWith('tel:') ||
              (request.url.startsWith('http') && !request.url.includes('ahhamilton.ca'))) {
            Linking.openURL(request.url);
            return false;
          }
          return true;
        }}
      />

      <View style={styles.tabBar}>
        <TouchableOpacity style={styles.tab} onPress={() => navigate(DASHBOARD_URL, 'home')}>
          <Text style={[styles.tabIcon, activeTab === 'home' && styles.tabActive]}>🏠</Text>
          <Text style={[styles.tabLabel, activeTab === 'home' && styles.tabLabelActive]}>Accueil</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.tab} onPress={() => navigate(SITE_URL + '/actualites.html', 'events')}>
          <Text style={[styles.tabIcon, activeTab === 'events' && styles.tabActive]}>🎉</Text>
          <Text style={[styles.tabLabel, activeTab === 'events' && styles.tabLabelActive]}>Activités</Text>
        </TouchableOpacity>
<TouchableOpacity style={styles.tab} onPress={() => navigate(DASHBOARD_URL + '#annuaire', 'mail')}>
          <Text style={[styles.tabIcon, activeTab === 'mail' && styles.tabActive]}>✉️</Text>
          <Text style={[styles.tabLabel, activeTab === 'mail' && styles.tabLabelActive]}>Courriel</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.tab} onPress={() => navigate(DASHBOARD_URL + '#profile', 'profile')}>
          <Text style={[styles.tabIcon, activeTab === 'profile' && styles.tabActive]}>👤</Text>
          <Text style={[styles.tabLabel, activeTab === 'profile' && styles.tabLabelActive]}>Profil</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1b5e20' },
  webview: { flex: 1 },
  splash: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#1b5e20', justifyContent: 'center', alignItems: 'center', zIndex: 100 },
  splashText: { color: '#fff', fontSize: 24, fontWeight: '900', marginTop: 20 },
  splashSub: { color: 'rgba(255,255,255,.6)', fontSize: 14, marginTop: 6 },
  tabBar: { flexDirection: 'row', backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#e0e0e0', paddingBottom: Platform.OS === 'ios' ? 20 : 4, paddingTop: 6, alignItems: 'center', justifyContent: 'space-around' },
  tab: { alignItems: 'center', flex: 1, paddingVertical: 2 },
  tabIcon: { fontSize: 20, color: '#999' },
  tabActive: { color: '#1b5e20' },
  tabLabel: { fontSize: 10, color: '#999', marginTop: 2 },
  tabLabelActive: { color: '#1b5e20', fontWeight: '600' },
});
