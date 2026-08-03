// Confirmed against the skill's own in-game description (via EVE Ref, which
// mirrors CCP's static data export), not assumed - other sources disagree
// with each other (5%, 25%), so this was checked directly rather than
// picking one: "Advanced skill at using Jump Drives. 20% increase in
// maximum jump range per skill level." (Jump Drive Calibration, type ID
// 21611, max level 5).
export const JUMP_DRIVE_CALIBRATION_BONUS_PER_LEVEL = 0.2;

export const MIN_JUMP_DRIVE_CALIBRATION_LEVEL = 1;
export const MAX_JUMP_DRIVE_CALIBRATION_LEVEL = 5;

export function isValidSkillLevel(level: unknown): level is number {
  return (
    typeof level === "number" &&
    Number.isInteger(level) &&
    level >= MIN_JUMP_DRIVE_CALIBRATION_LEVEL &&
    level <= MAX_JUMP_DRIVE_CALIBRATION_LEVEL
  );
}

// ShipCategory.baseRangeLY is the unskilled (level 0) range - this is what
// findJumpPath actually gets called with, computed fresh per request from
// whichever skill level the user selects, rather than baking one skill
// level into the stored category.
export function effectiveJumpRangeLY(baseRangeLY: number, skillLevel: number): number {
  return baseRangeLY * (1 + JUMP_DRIVE_CALIBRATION_BONUS_PER_LEVEL * skillLevel);
}
