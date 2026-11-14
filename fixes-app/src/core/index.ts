/**
 * Public surface of the platform-independent core. Later parts import from here (or from the
 * module barrels) rather than reaching into individual files.
 */
export * from './api';
export * from './backup';
export * from './config';
export * from './crypto';
export * from './db';
export * from './events';
export * from './linking';
export * from './logger';
export * from './messaging';
export * from './payloads';
export * from './platform';
export * from './realtime';
export * from './session';
export * from './snapshot';
export * from './trust';
export * from './utils';
