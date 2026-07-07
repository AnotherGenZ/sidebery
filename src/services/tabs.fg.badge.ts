import type * as T from 'src/types'
import { translate } from 'src/dict'
import * as Settings from 'src/services/settings'
import * as Tabs from 'src/services/tabs.fg'
import * as Sidebar from 'src/services/sidebar.fg'
import * as Notifications from 'src/services/notifications.fg'
import * as Logs from 'src/services/logs'
import * as Utils from 'src/utils'

export interface BadgeRule {
  src: string
  urgent: boolean
  urlRe: RegExp
  urlAny: boolean
  urlVal: boolean
  titleRe: RegExp
  titleAny: boolean
  titleVal: boolean
  hasVal: boolean
  notify: boolean
  excludePinned: boolean
  excludeNormal: boolean
  staticValue?: string
  minUrlAge?: number
  bg?: string
  fg?: string
}

const URL_RE = /url:(?<u>.+?)(?:; |;?$)/
const TITLE_RE = /title:(?<t>.+?)(?:; |;?$)/
const BG_RE = /bg:(?<bg>.+?)(?:; |;?$)/
const FG_RE = /fg:(?<fg>.+?)(?:; |;?$)/
const URGENT_RE = /urgent(?:; |;?$)/
const NOTIFY_RE = /notify(?:; |;?$)/
const PINNED_RE = /pinned(?:; |;?$)/
const NORMAL_RE = /normal(?:; |;?$)/
const VALUE_RE = /value:(?<v>.+?)(?:; |;?$)/
const MIN_URL_AGE_RE = /minUrlAge:(?<age>\d+?)(?:; |;?$)/
const VAL_GROUP_RE = /\(?<v>(?:.+?)\)/

const badgeRules: BadgeRule[] = []
let ageCalcNeeded = false

export let badgeRulesEnabled = false

export function parseBadgeRegexpRules() {
  badgeRules.length = 0
  badgeRulesEnabled = false

  if (!Settings.state.tabsBadge) return

  const rulesConf = Settings.state.tabsBadgeRules
  for (const rule of rulesConf.trim().split('\n')) {
    try {
      badgeRules.push(parseBadgeRegexpRule(rule))
    } catch {
      continue
    }
  }
  badgeRulesEnabled = badgeRules.length > 0
}

export function updateBadge(tab: T.Tab, change?: browser.tabs.ChangeInfo) {
  if (badgeRulesEnabled) {
    let urlMatched = false
    let titleMatched = false
    let urlVal: string | undefined
    let titleVal: string | undefined
    let urlAge
    if (ageCalcNeeded && tab.urlUpdated !== undefined) urlAge = Date.now() - tab.urlUpdated

    for (const rule of badgeRules) {
      if (rule.excludeNormal && !tab.pinned) continue
      if (rule.excludePinned && tab.pinned) continue
      urlMatched = rule.urlAny
      titleMatched = rule.titleAny
      if (!urlMatched) {
        if (rule.urlVal) {
          const result = rule.urlRe.exec(tab.url)
          urlMatched = !!result
          urlVal = result?.groups?.v
        } else {
          urlMatched = rule.urlRe.test(tab.url)
        }
      }
      if (!titleMatched) {
        if (rule.titleVal) {
          const result = rule.titleRe.exec(tab.title)
          titleMatched = !!result
          titleVal = result?.groups?.v
        } else {
          titleMatched = rule.titleRe.test(tab.title)
        }
      }
      if (urlMatched && titleMatched) {
        const badgeValue = urlVal || titleVal || rule.staticValue || true
        if (badgeValue === true && rule.urgent && (tab.active || tab.discarded)) continue
        if (rule.minUrlAge !== undefined) {
          if (urlAge === undefined) continue
          if (change?.title === undefined) continue
          if (urlAge < rule.minUrlAge) continue
          if (tab.status === 'loading') continue
        }
        tab.reactive.badge = tab.badge = badgeValue
        tab.reactive.badgeBg = rule.bg ?? null
        tab.reactive.badgeFg = rule.fg ?? null
        const prevUrg = tab.badgeUrgent
        if (rule.urgent && !tab.active && !tab.discarded) {
          if (!prevUrg) tab.reactive.badgeUrgent = tab.badgeUrgent = true
        } else {
          if (prevUrg) tab.reactive.badgeUrgent = tab.badgeUrgent = false
        }
        if (rule.notify && change) {
          Notifications.notify({
            id: 'urgenttab' + tab.id,
            icon: tab.favIconUrl,
            title: tab.title.length > 36 ? tab.title.slice(0, 36) + '…' : tab.title,
            details:
              tab.url.length > 50 ? tab.url.slice(0, 25) + '…' + tab.url.slice(-24) : tab.url,
            ctrl: !tab.active ? translate('notif.switch_to_tab') : undefined,
            callback: () => browser.tabs.update(tab.id, { active: true }).catch(() => {}),
          })
        }
        if (prevUrg !== tab.badgeUrgent) propagateBadgeUrgency(tab)
        return
      }
    }
  }

  if (tab.badge) {
    tab.reactive.badge = tab.badge = false
    tab.reactive.badgeBg = null
    tab.reactive.badgeFg = null
    if (tab.badgeUrgent) {
      tab.reactive.badgeUrgent = tab.badgeUrgent = false
      propagateBadgeUrgency(tab)
    }
  }
}

export function updateBadges() {
  for (const tab of Tabs.list) {
    if (!tab.internal) updateBadge(tab)
  }
}

export function resetBadges() {
  for (const panel of Sidebar.panels) {
    if (!Utils.isTabsPanel(panel)) continue
    panel.urgentTabIds.clear()
    panel.reactive.badge = false
  }
  for (const tab of Tabs.list) {
    tab.reactive.badge = tab.badge = false
    tab.reactive.badgeBg = null
    tab.reactive.badgeFg = null
    tab.urgentTabIds?.clear()
    tab.reactive.badgeUrgent = tab.badgeUrgent = false
  }
}

export function resetUrgencyAndValuelessBadge(tab: T.Tab) {
  if (tab.badgeUrgent) tab.reactive.badgeUrgent = tab.badgeUrgent = false
  if (tab.badge === true) tab.reactive.badge = tab.badge = false
}

/**
 * Propagate urgency state to parent tabs and panel.
 */
export function propagateBadgeUrgency(tab: T.Tab, urgency?: boolean) {
  if (urgency === undefined) urgency = tab.badgeUrgent

  // Propagate to ancestors
  Tabs.findAncestor(tab, t => {
    if (urgency) {
      if (!t.urgentTabIds) t.urgentTabIds = new Set()
      if (t.urgentTabIds.size === 0) t.reactive.hasUrgentDescendant = true
      t.urgentTabIds.add(tab.id)
    } else {
      const prevSize = t.urgentTabIds?.size ?? 0
      t.urgentTabIds?.delete(tab.id)
      if (prevSize > 0 && t.urgentTabIds?.size === 0) t.reactive.hasUrgentDescendant = false
    }
  })

  if (!tab.pinned || Settings.state.pinnedTabsPosition === 'panel') {
    const panel = Sidebar.panelsById[tab.panelId]
    if (!Utils.isTabsPanel(panel)) return
    if (urgency) {
      if (panel.urgentTabIds.size === 0) panel.reactive.badge = true
      panel.urgentTabIds.add(tab.id)
    } else {
      const prevSize = panel.urgentTabIds.size
      panel.urgentTabIds.delete(tab.id)
      if (prevSize > 0) panel.reactive.badge = panel.urgentTabIds.size > 0
    }
  }
}

function reHasValGroup(re: string): boolean {
  return VAL_GROUP_RE.test(re)
}

export function parseBadgeRegexpRule(rule: string): BadgeRule {
  rule = rule.trim()
  if (!rule) throw 'no rule'

  const urlReStr = URL_RE.exec(rule)?.groups?.u
  const titleReStr = TITLE_RE.exec(rule)?.groups?.t
  const urlVal = urlReStr ? reHasValGroup(urlReStr) : false
  const titleVal = titleReStr ? reHasValGroup(titleReStr) : false
  const bg = BG_RE.exec(rule)?.groups?.bg
  const fg = FG_RE.exec(rule)?.groups?.fg
  const pinned = PINNED_RE.test(rule)
  const normal = NORMAL_RE.test(rule)
  const urgent = URGENT_RE.test(rule)
  const notify = NOTIFY_RE.test(rule)
  const staticValue = VALUE_RE.exec(rule)?.groups?.v
  const minUrlAgeStr = MIN_URL_AGE_RE.exec(rule)?.groups?.age
  const minUrlAge = minUrlAgeStr ? parseInt(minUrlAgeStr) : undefined
  const excludePinned = !pinned && normal
  const excludeNormal = !normal && pinned

  if (!ageCalcNeeded) {
    ageCalcNeeded = minUrlAge !== undefined && !isNaN(minUrlAge)
  }

  return {
    src: rule,
    urlRe: new RegExp(urlReStr ?? ''),
    urlAny: !urlReStr || urlReStr === '.*',
    urlVal,
    titleRe: new RegExp(titleReStr ?? ''),
    titleAny: !titleReStr || titleReStr === '.*',
    titleVal,
    hasVal: urlVal || titleVal,
    urgent,
    notify,
    excludePinned,
    excludeNormal,
    staticValue: staticValue === '.' ? ' ' : staticValue,
    minUrlAge: minUrlAge && !isNaN(minUrlAge) ? minUrlAge : undefined,
    bg,
    fg,
  }
}

export const TESTING = {
  badgeRules,
  reHasValGroup,
}
