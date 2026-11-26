// Редакция программы. Скорость машины зафиксирована и не настраивается.
import type { MachineProfile } from './core/gcode';

export const LOCKED: boolean = true;
/** Скорость письма и переездов, мм/мин. */
export const LOCK_F = 2000;

/** Привести профиль машины к зафиксированной скорости. */
export function lockProfile<T extends MachineProfile>(p: T): T {
  return { ...p, drawSpeed: LOCK_F, travelSpeed: LOCK_F, useG0ForTravel: false };
}