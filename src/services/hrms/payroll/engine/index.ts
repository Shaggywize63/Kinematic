// The payroll engine on the server: a port of the dashboard's pure engine (see engine.ts). Plain data in, plain data out;
// nothing in this folder reads the database, the clock (except uid() ids and the F&F tenure default) or the network.
export * from './types';
export * from './rules';
export * from './format';
export * from './engine';
export * from './logic';
export { looksMaskedPan, looksMaskedAccount, hasMaskedSensitive } from './masking';
