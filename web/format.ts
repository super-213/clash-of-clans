import type { Unit } from '../shared/schema';

export const purposes: Record<string, string> = {
  all: '全部用途',
  war: '部落战',
  trophy: '冲杯防守',
  farming: '资源保护',
  hybrid: '综合阵型',
  general: '通用',
};
const unitNames: Record<string, string> = {
  Dragon: '飞龙',
  'Dragon Rider': '龙骑士',
  'Inferno Dragon': '地狱飞龙',
  'Electro Dragon': '雷电飞龙',
  Balloon: '气球兵',
  'Baby Dragon': '飞龙宝宝',
  Healer: '天使',
  'Super Bowler': '超级巨石投手',
  Bowler: '巨石投手',
  'Archer Queen': '弓箭女皇',
  'Barbarian King': '野蛮人之王',
  'Grand Warden': '大守护者',
  'Minion Prince': '亡灵王子',
  'Royal Champion': '飞盾战神',
  'Rage Spell': '狂暴法术',
  'Freeze Spell': '冰冻法术',
  'Lightning Spell': '雷电法术',
  'Poison Spell': '毒药法术',
  'Jump Spell': '弹跳法术',
  'Healing Spell': '治疗法术',
  'Haste Spell': '急速法术',
  'Invisibility Spell': '隐身法术',
  'Ice Golem': '寒冰戈仑',
  'Super Wall Breaker': '超级炸弹人',
  'Wall Breaker': '炸弹人',
  Minion: '亡灵',
  'Hog Rider': '野猪骑士',
  Miner: '掘地矿工',
  'Lava Hound': '熔岩猎犬',
  Wizard: '法师',
};
export const date = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Shanghai',
      }).format(new Date(value))
    : '尚未采集';
export const unitName = (unit: Unit) => unitNames[unit.name] || unit.name;
export const fullDate = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'Asia/Shanghai',
  }).format(new Date(value)) + '（北京时间）';
