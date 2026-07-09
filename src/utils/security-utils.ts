// >= this raw value is high-sec (0.5 to 1.0).
export const HIGH_SEC_THRESHOLD = 0.5;

// A system is null-sec only if its true security status is at or below
// 0.0. Per EVE University (https://wiki.eveuniversity.org/System_security):
// true security strictly between 0.0 and 0.05 rounds *up* to display as
// 0.1 (low-sec), rather than down to 0.0 - so anything above 0.0, even
// fractionally, is low-sec, not null-sec.
export const NULL_SEC_THRESHOLD = 0.0;

export function isHighSec(securityStatus: number | null): boolean {
  return securityStatus !== null && securityStatus >= HIGH_SEC_THRESHOLD;
}

export function isNullSec(securityStatus: number | null): boolean {
  return securityStatus !== null && securityStatus <= NULL_SEC_THRESHOLD;
}
