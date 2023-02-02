import { emberVirtualPackages, emberVirtualPeerDeps, packageName as getPackageName } from '@embroider/shared-internals';
import { dirname, resolve } from 'path';
import { PackageCache, Package, V2Package, explicitRelative } from '@embroider/shared-internals';
import { compile } from './js-handlebars';
import makeDebug from 'debug';
import assertNever from 'assert-never';
const debug = makeDebug('embroider:resolver');

export interface Options {
  renamePackages: {
    [fromName: string]: string;
  };
  renameModules: {
    [fromName: string]: string;
  };
  extraImports: {
    absPath: string;
    target: string;
    runtimeName?: string;
  }[];
  externalsDir: string;
  activeAddons: {
    [packageName: string]: string;
  };
  relocatedFiles: { [relativePath: string]: string };
  resolvableExtensions: string[];
  appRoot: string;
}

const externalPrefix = '/@embroider/external/';

export interface ModuleRequest {
  specifier: string;
  fromFile: string;
  isVirtual: boolean;
  alias(newSpecifier: string, newFromFile?: string): this;
  rehome(newFromFile: string): this;
  virtualize(virtualFilename: string): this;
}

// This is generic because different build systems have different ways of
// representing a found module, and we just pass those values through.
export type Resolution<T = unknown, E = unknown> = { type: 'found'; result: T } | { type: 'not_found'; err: E };

export type ResolverFunction<R extends ModuleRequest = ModuleRequest, T = unknown, E = unknown> = (
  request: R
) => Promise<Resolution<T, E>>;

export class Resolver {
  // Given a filename that was passed to your ModuleRequest's `virtualize()`,
  // this produces the corresponding contents. It's a static, stateless function
  // because we recognize that that process that did resolution might not be the
  // same one that loads the content.
  static virtualContent(filename: string): string | undefined {
    if (filename.startsWith(externalPrefix)) {
      return externalShim({ moduleName: filename.slice(externalPrefix.length) });
    }
    return undefined;
  }

  constructor(private options: Options) {}

  async beforeResolve<R extends ModuleRequest>(request: R): Promise<R> {
    if (request.specifier === '@embroider/macros') {
      // the macros package is always handled directly within babel (not
      // necessarily as a real resolvable package), so we should not mess with it.
      // It might not get compiled away until *after* our plugin has run, which is
      // why we need to know about it.
      return request;
    }

    return this.preHandleExternal(this.handleRenaming(request));
  }

  async fallbackResolve<R extends ModuleRequest>(request: R): Promise<R> {
    return this.postHandleExternal(request);
  }

  // This encapsulates the whole resolving process. Given a `defaultResolve`
  // that calls your build system's normal module resolver, this does both pre-
  // and post-resolution adjustments as needed to implement our compatibility
  // rules.
  //
  // Depending on the plugin architecture you're working in, it may be easier to
  // call beforeResolve and fallbackResolve directly, in which case matching the
  // details of the recursion to what this method does are your responsibility.
  async resolve<R extends ModuleRequest, T, E>(
    request: R,
    defaultResolve: ResolverFunction<R, T, E>
  ): Promise<Resolution<T, E>> {
    request = await this.beforeResolve(request);
    let resolution = await defaultResolve(request);
    switch (resolution.type) {
      case 'found':
        return resolution;
      case 'not_found':
        break;
      default:
        throw assertNever(resolution);
    }
    let nextRequest = await this.fallbackResolve(request);
    if (nextRequest === request) {
      // no additional fallback is available.
      return resolution;
    }
    if (nextRequest.isVirtual) {
      // virtual requests are terminal, there is no more beforeResolve or
      // fallbackResolve around them. The defaultResolve is expected to know how
      // to implement them.
      return await defaultResolve(nextRequest);
    }
    return await this.resolve(nextRequest, defaultResolve);
  }

  private owningPackage(fromFile: string): Package | undefined {
    return PackageCache.shared('embroider-stage3', this.options.appRoot).ownerOfFile(fromFile);
  }

  private originalPackage(fromFile: string): V2Package | undefined {
    let originalFile = this.options.relocatedFiles[fromFile];
    if (originalFile) {
      let owning = PackageCache.shared('embroider-stage3', this.options.appRoot).ownerOfFile(originalFile);
      if (owning && !owning.isV2Ember()) {
        throw new Error(`bug: it should only be possible for a v2 ember package to own relocated files`);
      }
      return owning;
    }
  }

  private handleRenaming<R extends ModuleRequest>(request: R): R {
    let packageName = getPackageName(request.specifier);
    if (!packageName) {
      return request;
    }

    for (let [candidate, replacement] of Object.entries(this.options.renameModules)) {
      if (candidate === request.specifier) {
        debug(`[beforeResolve] aliased ${request.specifier} in ${request.fromFile} to ${replacement}`);
        return request.alias(replacement);
      }
      for (let extension of this.options.resolvableExtensions) {
        if (candidate === request.specifier + '/index' + extension) {
          return request.alias(replacement);
        }
        if (candidate === request.specifier + extension) {
          return request.alias(replacement);
        }
      }
    }

    if (this.options.renamePackages[packageName]) {
      return request.alias(request.specifier.replace(packageName, this.options.renamePackages[packageName]));
    }

    let pkg = this.owningPackage(request.fromFile);
    if (!pkg || !pkg.isV2Ember()) {
      return request;
    }

    if (pkg.meta['auto-upgraded'] && pkg.name === packageName) {
      // we found a self-import, resolve it for them. Only auto-upgraded
      // packages get this help, v2 packages are natively supposed to make their
      // own modules resolvable, and we want to push them all to do that
      // correctly.
      return request.alias(this.resolveWithinPackage(request.specifier, pkg));
    }

    let originalPkg = this.originalPackage(request.fromFile);
    if (originalPkg && pkg.meta['auto-upgraded'] && originalPkg.name === packageName) {
      // A file that was relocated out of a package is importing that package's
      // name, it should find its own original copy.
      return request.alias(this.resolveWithinPackage(request.specifier, originalPkg));
    }

    return request;
  }

  private resolveWithinPackage(specifier: string, pkg: Package): string {
    if ('exports' in pkg.packageJSON) {
      // this is the easy case -- a package that uses exports can safely resolve
      // its own name
      return require.resolve(specifier, { paths: [pkg.root] });
    }
    return specifier.replace(pkg.name, pkg.root);
  }

  private preHandleExternal<R extends ModuleRequest>(request: R): R {
    let { specifier, fromFile } = request;
    let pkg = this.owningPackage(fromFile);
    if (!pkg || !pkg.isV2Ember()) {
      return request;
    }

    let packageName = getPackageName(specifier);
    if (!packageName) {
      // This is a relative import. We don't automatically externalize those
      // because it's rare, and by keeping them static we give better errors. But
      // we do allow them to be explicitly externalized by the package author (or
      // a compat adapter). In the metadata, they would be listed in
      // package-relative form, so we need to convert this specifier to that.
      let absoluteSpecifier = resolve(dirname(fromFile), specifier);
      let packageRelativeSpecifier = explicitRelative(pkg.root, absoluteSpecifier);
      if (isExplicitlyExternal(packageRelativeSpecifier, pkg)) {
        let publicSpecifier = absoluteSpecifier.replace(pkg.root, pkg.name);
        return external('beforeResolve', request, publicSpecifier);
      } else {
        return request;
      }
    }

    // absolute package imports can also be explicitly external based on their
    // full specifier name
    if (isExplicitlyExternal(specifier, pkg)) {
      return external('beforeResolve', request, specifier);
    }

    if (!pkg.meta['auto-upgraded'] && emberVirtualPeerDeps.has(packageName)) {
      // Native v2 addons are allowed to use the emberVirtualPeerDeps like
      // `@glimmer/component`. And like all v2 addons, it's important that they
      // see those dependencies after those dependencies have been converted to
      // v2.
      //
      // But unlike auto-upgraded addons, native v2 addons are not necessarily
      // copied out of their original place in node_modules. And from that
      // original place they might accidentally resolve the emberVirtualPeerDeps
      // that are present there in v1 format.
      //
      // So before we let normal resolving happen, we adjust these imports to
      // point at the app's copies instead.
      if (!this.options.activeAddons[packageName]) {
        throw new Error(`${pkg.name} is trying to import the app's ${packageName} package, but it seems to be missing`);
      }
      let newHome = resolve(this.options.appRoot, 'package.json');
      debug(`[beforeResolve] rehomed ${request.specifier} from ${request.fromFile} to ${newHome}`);
      return request.rehome(newHome);
    }

    if (pkg.meta['auto-upgraded'] && !pkg.hasDependency('ember-auto-import')) {
      try {
        let dep = PackageCache.shared('embroider-stage3', this.options.appRoot).resolve(packageName, pkg);
        if (!dep.isEmberPackage()) {
          // classic ember addons can only import non-ember dependencies if they
          // have ember-auto-import.
          return external('beforeResolve', request, specifier);
        }
      } catch (err) {
        if (err.code !== 'MODULE_NOT_FOUND') {
          throw err;
        }
      }
    }

    // assertions on what native v2 addons can import
    if (!pkg.meta['auto-upgraded']) {
      let originalPkg = this.originalPackage(fromFile);
      if (originalPkg) {
        // this file has been moved into another package (presumably the app).
        if (packageName !== pkg.name) {
          // the only thing that native v2 addons are allowed to import from
          // within the app tree is their own name.
          throw new Error(
            `${pkg.name} is trying to import ${packageName} from within its app tree. This is unsafe, because ${pkg.name} can't control which dependencies are resolvable from the app`
          );
        }
      } else {
        // this file has not been moved. The normal case.
        if (!pkg.meta['auto-upgraded'] && !reliablyResolvable(pkg, packageName)) {
          throw new Error(
            `${pkg.name} is trying to import from ${packageName} but that is not one of its explicit dependencies`
          );
        }
      }
    }
    return request;
  }

  private postHandleExternal<R extends ModuleRequest>(request: R): R {
    let { specifier, fromFile } = request;
    let pkg = this.owningPackage(fromFile);
    if (!pkg || !pkg.isV2Ember()) {
      return request;
    }

    let packageName = getPackageName(specifier);
    if (!packageName) {
      // this is a relative import, we have nothing more to for it.
      return request;
    }

    let originalPkg = this.originalPackage(fromFile);
    if (originalPkg) {
      // we didn't find it from the original package, so try from the relocated
      // package
      return request.rehome(resolve(originalPkg.root, 'package.json'));
    }

    // auto-upgraded packages can fall back to the set of known active addons
    //
    // v2 packages can fall back to the set of known active addons only to find
    // themselves (which is needed due to app tree merging)
    if ((pkg.meta['auto-upgraded'] || packageName === pkg.name) && this.options.activeAddons[packageName]) {
      return request.alias(
        this.resolveWithinPackage(
          specifier,
          PackageCache.shared('embroider-stage3', this.options.appRoot).get(this.options.activeAddons[packageName])
        )
      );
    }

    if (pkg.meta['auto-upgraded']) {
      // auto-upgraded packages can fall back to attempting to find dependencies at
      // runtime. Native v2 packages can only get this behavior in the
      // isExplicitlyExternal case above because they need to explicitly ask for
      // externals.
      return external('fallbackResolve', request, specifier);
    } else {
      // native v2 packages don't automatically externalize *everything* the way
      // auto-upgraded packages do, but they still externalize known and approved
      // ember virtual packages (like @ember/component)
      if (emberVirtualPackages.has(packageName)) {
        return external('fallbackResolve', request, specifier);
      }
    }

    // this is falling through with the original specifier which was
    // non-resolvable, which will presumably cause a static build error in stage3.
    return request;
  }
}

function isExplicitlyExternal(specifier: string, fromPkg: V2Package): boolean {
  return Boolean(fromPkg.isV2Addon() && fromPkg.meta['externals'] && fromPkg.meta['externals'].includes(specifier));
}

// we don't want to allow things that resolve only by accident that are likely
// to break in other setups. For example: import your dependencies'
// dependencies, or importing your own name from within a monorepo (which will
// work because of the symlinking) without setting up "exports" (which makes
// your own name reliably resolvable)
function reliablyResolvable(pkg: V2Package, packageName: string) {
  if (pkg.hasDependency(packageName)) {
    return true;
  }

  if (pkg.name === packageName && pkg.packageJSON.exports) {
    return true;
  }

  if (emberVirtualPeerDeps.has(packageName) || emberVirtualPackages.has(packageName)) {
    return true;
  }

  return false;
}

function external<R extends ModuleRequest>(label: string, request: R, specifier: string): R {
  let filename = externalPrefix + specifier;
  debug(`[${label}] virtualized ${request.specifier} as ${filename}`);
  return request.virtualize(filename);
}

const externalShim = compile(`
{{#if (eq moduleName "require")}}
const m = window.requirejs;
{{else}}
const m = window.require("{{{js-string-escape moduleName}}}");
{{/if}}
{{!-
  There are plenty of hand-written AMD defines floating around
  that lack this, and they will break when other build systems
  encounter them.

  As far as I can tell, Ember's loader was already treating this
  case as a module, so in theory we aren't breaking anything by
  marking it as such when other packagers come looking.

  todo: get review on this part.
-}}
if (m.default && !m.__esModule) {
  m.__esModule = true;
}
module.exports = m;
`) as (params: { moduleName: string }) => string;
