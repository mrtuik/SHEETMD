// All app icons. Put the PNG files in  assets/icons/  with exactly these names.
// Draw them solid black on a transparent background (the app tints them), about 96x96 px.
export const ICONS = {
  menu: require('../assets/icons/ic_tuik_menu.png'),
  settings: require('../assets/icons/ic_tuik_settings.png'),
  models: require('../assets/icons/ic_tuik_models.png'),
  close: require('../assets/icons/ic_tuik_close.png'),
  plus: require('../assets/icons/ic_tuik_plus.png'),
  minus: require('../assets/icons/ic_tuik_minus.png'),
  mic: require('../assets/icons/ic_tuik_mic.png'),
  send: require('../assets/icons/ic_tuik_send.png'),
  prev: require('../assets/icons/ic_tuik_prev.png'),
  next: require('../assets/icons/ic_tuik_next.png'),
  play: require('../assets/icons/ic_tuik_play.png'),
  pause: require('../assets/icons/ic_tuik_pause.png'),
  chevronDown: require('../assets/icons/ic_tuik_chevron_down.png'),
  speed: require('../assets/icons/ic_tuik_speed.png'),
  timer: require('../assets/icons/ic_tuik_timer.png'),
  battery: require('../assets/icons/ic_tuik_battery.png'),
  screen: require('../assets/icons/ic_tuik_screen.png'),
  file: require('../assets/icons/ic_tuik_file.png'),
  trash: require('../assets/icons/ic_tuik_trash.png'),
  check: require('../assets/icons/ic_tuik_check.png'),
  copy: require('../assets/icons/ic_tuik_copy.png'),
  like: require('../assets/icons/ic_tuik_like.png'),
} as const;
export type IconName = keyof typeof ICONS;
