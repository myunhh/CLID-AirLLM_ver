import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const GLOB_PATTERN = /[*?\[\]{}]/u;
const WINDOWS_DEVICE_PATTERN = /^(?:\\\\[.?]\\|\\[?][?]\\|(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[.:\\/]|$))/iu;

export class PathIdentityError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'PathIdentityError';
    this.code = code;
  }
}

function fail(code) {
  throw new PathIdentityError(code);
}

function hostIsWindows(platform) {
  return platform === 'win32';
}

function validateSpelling(value, platform) {
  if (typeof value !== 'string' || value.length === 0) fail('PATH_INVALID');
  if (value.includes('\0')) fail('PATH_NUL_FORBIDDEN');
  if (GLOB_PATTERN.test(value)) fail('PATH_GLOB_FORBIDDEN');
  if (hostIsWindows(platform) && WINDOWS_DEVICE_PATTERN.test(value)) fail('PATH_DEVICE_FORBIDDEN');
}

function comparisonPath(value, platform) {
  const normalized = path.normalize(value);
  return hostIsWindows(platform) ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function contained(root, candidate, platform) {
  const rootKey = comparisonPath(root, platform);
  const candidateKey = comparisonPath(candidate, platform);
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}${path.sep}`);
}

function nearestExisting(absolute) {
  const suffix = [];
  let cursor = absolute;
  for (;;) {
    try {
      fs.lstatSync(cursor);
      return { ancestor: cursor, suffix };
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) fail('PATH_ROOT_NOT_FOUND');
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
}

export function resolveWorkspaceRoot(workspaceRoot, options = {}) {
  const platform = options.platform ?? process.platform;
  validateSpelling(workspaceRoot, platform);
  const absolute = path.resolve(workspaceRoot);
  let canonical;
  try {
    canonical = fs.realpathSync.native(absolute);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') fail('WORKSPACE_ROOT_NOT_FOUND');
    throw error;
  }
  if (!fs.statSync(canonical).isDirectory()) fail('WORKSPACE_ROOT_NOT_DIRECTORY');
  return Object.freeze({
    declaredWorkspaceRoot: workspaceRoot,
    absoluteWorkspaceRoot: absolute,
    canonicalWorkspaceRoot: comparisonPath(canonical, platform),
    platform,
  });
}

function ensureRootIdentity(rootOrPath, options) {
  if (rootOrPath && typeof rootOrPath === 'object' && rootOrPath.canonicalWorkspaceRoot) return rootOrPath;
  return resolveWorkspaceRoot(rootOrPath, options);
}

export function canonicalPathIdentity(declaredPath, workspaceRoot, options = {}) {
  const root = ensureRootIdentity(workspaceRoot, options);
  const platform = root.platform;
  validateSpelling(declaredPath, platform);
  const absolute = path.isAbsolute(declaredPath)
    ? path.normalize(declaredPath)
    : path.resolve(root.absoluteWorkspaceRoot, declaredPath);

  if (hostIsWindows(platform)) {
    const rootParsed = path.parse(root.absoluteWorkspaceRoot);
    const candidateParsed = path.parse(absolute);
    if (rootParsed.root.toLocaleLowerCase('en-US') !== candidateParsed.root.toLocaleLowerCase('en-US')) {
      fail('PATH_CROSS_VOLUME_FORBIDDEN');
    }
  }
  if (!contained(root.absoluteWorkspaceRoot, absolute, platform)) fail('PATH_OUTSIDE_WORKSPACE');

  const { ancestor, suffix } = nearestExisting(absolute);
  const realAncestor = fs.realpathSync.native(ancestor);
  if (!contained(root.canonicalWorkspaceRoot, realAncestor, platform)) fail('PATH_REPARSE_ESCAPE');
  const canonicalAbsolute = comparisonPath(path.join(realAncestor, ...suffix), platform);
  if (!contained(root.canonicalWorkspaceRoot, canonicalAbsolute, platform)) fail('PATH_OUTSIDE_WORKSPACE');
  if (options.mustExist && suffix.length > 0) fail('PATH_NOT_FOUND');

  return Object.freeze({
    declaredPath,
    declaredAbsolutePath: absolute,
    canonicalAbsolutePath: canonicalAbsolute,
    canonicalWorkspaceRoot: root.canonicalWorkspaceRoot,
    relativePath: path.relative(root.canonicalWorkspaceRoot, canonicalAbsolute),
    lockHash: createHash('sha256').update(canonicalAbsolute).digest('hex'),
  });
}

export function assertPathIdentityUnchanged(identity, workspaceRoot, options = {}) {
  const current = canonicalPathIdentity(identity.declaredPath, workspaceRoot, options);
  if (current.canonicalAbsolutePath !== identity.canonicalAbsolutePath || current.lockHash !== identity.lockHash) {
    fail('PATH_IDENTITY_DRIFT');
  }
  return current;
}
