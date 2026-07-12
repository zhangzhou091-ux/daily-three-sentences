/** 学习卡片 / 复习卡片统一最小高度（px）
 *  根因：.card-front/.card-back 为 position:absolute，卡片高度完全由 .card-inner 的 minHeight 决定。
 *  380px 覆盖 ReviewCard 三栏头部（含"下次复习"badge ~38px）+ 长英文 3-4 行场景，余量 ~130px。
 */
export const CARD_MIN_HEIGHT = 380;
