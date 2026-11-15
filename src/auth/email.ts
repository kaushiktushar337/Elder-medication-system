import { text } from '../core.ts';

export const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
export const emailOf = value => text(value, 254).toLowerCase();
