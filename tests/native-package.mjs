import { currentTarget } from '../scripts/native-target.mjs';

/** The platform package the loader resolves on this machine. */
export const nativePackage = currentTarget().package;
