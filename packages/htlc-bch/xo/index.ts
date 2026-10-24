import { parseTemplate, serializeTemplate } from '@xo-cash/utils';
import { ferryHtlcTemplate } from './ferry-htlc.template.js';

export { ferryHtlcTemplate };

export function getParsedFerryHtlcTemplate() {
  return parseTemplate(ferryHtlcTemplate);
}

export function serializeFerryHtlcTemplate() {
  return serializeTemplate(ferryHtlcTemplate);
}
