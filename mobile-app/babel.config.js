module.exports = function(api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // NativeWind : compile les classes Tailwind en StyleSheet natif
    plugins: ['nativewind/babel'],
  };
};
