/**
 * One problem the pack checker found. `message` is for a person (or their AI) who has never read
 * the hub's source: what is wrong and what to do about it. `rule` is a stable id for tests and for
 * looking the problem up in docs/theme-packs.md.
 *
 * @typedef {{ level: 'error' | 'warning', where: string, rule: string, message: string }} Finding
 */

/** @returns {Finding} */
export const finding = (level, where, rule, message) => ({ level, where, rule, message })
export const error = (where, rule, message) => finding('error', where, rule, message)
export const warning = (where, rule, message) => finding('warning', where, rule, message)
