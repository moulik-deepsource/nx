import * as minimist from 'minimist';
import { getLogger } from '../shared/logger';
import { combineOptionsForSchematic, convertToCamelCase, handleErrors, Options, Schema } from '../shared/params';
import { commandName, printHelp } from '../shared/print-help';
import { WorkspaceDefinition, Workspaces } from '../shared/workspace';
import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { mkdirpSync, rmdirSync } from 'fs-extra';
import * as path from 'path';
import * as chalk from 'chalk';

export interface GenerateOptions {
  collectionName: string;
  schematicName: string;
  schematicOptions: Options;
  help: boolean;
  debug: boolean;
  dryRun: boolean;
  force: boolean;
  interactive: boolean;
  defaults: boolean;
}

function throwInvalidInvocation() {
  throw new Error(
    `Specify the schematic name (e.g., ${commandName} generate collection-name:schematic-name)`
  );
}

function parseGenerateOpts(
  args: string[],
  mode: 'generate' | 'new',
  defaultCollection: string | null
): GenerateOptions {
  const schematicOptions = convertToCamelCase(
    minimist(args, {
      boolean: ['help', 'dryRun', 'debug', 'force', 'interactive'],
      alias: {
        dryRun: 'dry-run',
        d: 'dryRun'
      },
      default: {
        debug: false,
        dryRun: false,
        interactive: true
      }
    })
  );

  let collectionName: string | null = null;
  let schematicName: string | null = null;
  if (mode === 'generate') {
    if (
      !schematicOptions['_'] ||
      (schematicOptions['_'] as string[]).length === 0
    ) {
      throwInvalidInvocation();
    }
    [collectionName, schematicName] = (schematicOptions['_'] as string[])
      .shift()
      .split(':');
    if (!schematicName) {
      schematicName = collectionName;
      collectionName = defaultCollection;
    }
  } else {
    collectionName = schematicOptions.collection as string;
    schematicName = '';
  }

  if (!collectionName) {
    throwInvalidInvocation();
  }

  const res = {
    collectionName,
    schematicName,
    schematicOptions,
    help: schematicOptions.help as boolean,
    debug: schematicOptions.debug as boolean,
    dryRun: schematicOptions.dryRun as boolean,
    force: schematicOptions.force as boolean,
    interactive: schematicOptions.interactive as boolean,
    defaults: schematicOptions.defaults as boolean
  };

  delete schematicOptions.debug;
  delete schematicOptions.d;
  delete schematicOptions.dryRun;
  delete schematicOptions.force;
  delete schematicOptions.interactive;
  delete schematicOptions.defaults;
  delete schematicOptions.help;
  delete schematicOptions['--'];

  return res;
}


export function printGenHelp(
  opts: GenerateOptions,
  schema: Schema,
  logger: Console
) {
  printHelp(
    `${commandName} generate ${opts.collectionName}:${opts.schematicName}`,
    {
      ...schema,
      properties: {
        ...schema.properties,
        dryRun: {
          type: 'boolean',
          default: false,
          description: `Runs through and reports activity without writing to disk.`
        }
      }
    },
    logger as any
  );
}

function readDefaultCollection(workspace: WorkspaceDefinition) {
  return workspace.cli ? workspace.cli.defaultCollection : null;
}

export async function taoNew(root: string, args: string[], isVerbose = false) {
  const logger = getLogger(isVerbose);
  return handleErrors(logger, isVerbose, async () => {
    const opts = parseGenerateOpts(
      args,
      'new',
      null
    );
    return (await import('./ngcli-adapter')).invokeNew(logger, root, opts);
  });
}

export interface Tree {
  read(filePath: string): Buffer | null;

  write(filePath: string, content: Buffer | string): void;

  exists(filePath: string): boolean;

  delete(filePath: string): void;

  rename(from: string, to: string): void;

  isFile(filePath: string): boolean;

  children(dirPath: string): string[];
}

export interface FileChange {
  path: string;
  type: 'CREATE' | 'DELETE' | 'UPDATE';
  content: Buffer | null;
}


export class FsTree implements Tree {
  private recordedChanges: { [path: string]: { content: Buffer | null, isDeleted: boolean } } = {};

  constructor(private readonly root: string, private readonly isVerbose: boolean, private readonly logger: Console) {
  }

  read(filePath: string): Buffer | null {
    try {
      if (this.recordedChanges[this.rp(filePath)]) {
        return this.recordedChanges[this.rp(filePath)].content;
      } else {
        return readFileSync(this.ap(filePath));
      }
    } catch (e) {
      if (this.isVerbose) {
        this.logger.error(e);
      }
      return null;
    }
  }

  write(filePath: string, content: Buffer | string): void {
    try {
      this.recordedChanges[this.rp(filePath)] = { content: Buffer.from(content), isDeleted: false };
    } catch (e) {
      if (this.isVerbose) {
        this.logger.error(e);
      }
    }
  }

  overwrite(filePath: string, content: Buffer | string): void {
    this.write(filePath, content);
  }

  exists(filePath: string): boolean {
    try {
      if (this.recordedChanges[this.rp(filePath)]) {
        return !this.recordedChanges[this.rp(filePath)].isDeleted;
      } else if (this.filesForDir(this.rp(filePath)).length > 0) {
        return true;
      } else {
        const stat = statSync(this.ap(filePath));
        return stat.isFile() || stat.isDirectory();
      }
    } catch (err) {
      return false;
    }
  }

  delete(filePath: string): void {
    if (this.filesForDir(this.rp(filePath)).length > 0) {
      this.filesForDir(this.rp(filePath)).forEach(f => this.recordedChanges[f] = { content: null, isDeleted: true });
    }
    this.recordedChanges[this.rp(filePath)] = { content: null, isDeleted: true };
  }

  rename(from: string, to: string): void {
    const content = this.read(this.rp(from));
    this.recordedChanges[this.rp(from)] = { content: null, isDeleted: true };
    this.recordedChanges[this.rp(to)] = { content: content, isDeleted: false };
  }

  isFile(filePath: string): boolean {
    try {
      if (this.recordedChanges[this.rp(filePath)]) {
        return !this.recordedChanges[this.rp(filePath)].isDeleted;
      } else {
        const stat = statSync(this.ap(filePath));
        return stat.isFile();
      }
    } catch (err) {
      return false;
    }
  }

  children(dirPath: string): string[] {
    let res = [];
    try {
      res = readdirSync(this.ap(dirPath));
    } catch (e) {
    }

    res = [...res, ...this.directChildrenOfDir(this.rp(dirPath))];
    return res.filter(q => {
      const r = this.recordedChanges[path.join(this.rp(dirPath), q)];
      if (r && r.isDeleted) return false;
      return true;
    });
  }

  listChanges(): FileChange[] {
    const res = [] as FileChange[];
    Object.keys(this.recordedChanges).forEach(f => {
      if (this.recordedChanges[f].isDeleted) {
        if (this.fsExists(f)) {
          res.push({ path: f, type: 'DELETE', content: null });
        }
      } else {
        if (this.fsExists(f)) {
          res.push({ path: f, type: 'UPDATE', content: this.recordedChanges[f].content });
        } else {
          res.push({ path: f, type: 'CREATE', content: this.recordedChanges[f].content });
        }
      }
    });
    return res;
  }

  private filesForDir(path: string): string[] {
    return Object.keys(this.recordedChanges).filter(f => f.startsWith(path + '/') && !this.recordedChanges[f].isDeleted);
  }

  private directChildrenOfDir(path: string): string[] {
    const res = {};
    Object.keys(this.recordedChanges).forEach(f => {
      if (f.startsWith(path + '/')) {
        const [_, file] = f.split(path + '/');
        res[file.split('/')[0]] = true;
      }
    });
    return Object.keys(res);
  }

  private fsExists(filePath: string): boolean {
    try {
      const stat = statSync(this.ap(filePath));
      return stat.isFile() || stat.isDirectory();
    } catch (e) {
      return false;
    }
  }

  private rp(pp: string) {
    return pp.startsWith('/') ? pp.substring(1) : pp;
  }

  private ap(pp: string) {
    return path.join(this.root, pp);
  }
}

export function flushChanges(root: string, fileChanges: FileChange[]) {
  fileChanges.forEach(f => {
    const fpath = path.join(root, f.path);
    if (f.type === 'CREATE') {
      mkdirpSync(path.dirname(fpath));
      writeFileSync(fpath, f.content);

    } else if (f.type === 'UPDATE') {
      writeFileSync(fpath, f.content);

    } else if (f.type === 'DELETE') {
      try {
        const stat = statSync(fpath);
        if (stat.isDirectory()) {
          rmdirSync(fpath, { recursive: true });
        } else {
          unlinkSync(fpath);
        }
      } catch (e) {
      }
    }
  });
}

function printChanges(fileChanges: FileChange[]) {
  fileChanges.forEach(f => {
    if (f.type === 'CREATE') {
      console.log(`${chalk.default.green('CREATE')} ${f}`)
    } else if (f.type === 'UPDATE') {
      console.log(`${chalk.default.white('UPDATE')} ${f}`)
    } else if (f.type === 'DELETE') {
      console.log(`${chalk.default.yellow('DELETE')} ${f}`)
    }
  });
}


export async function generate(
  root: string,
  args: string[],
  isVerbose = false
) {
  const logger = getLogger(isVerbose);
  const ws = new Workspaces();

  return handleErrors(logger, isVerbose, async () => {
    const workspaceDefinition = await ws.readWorkspaceConfiguration(root);
    const opts = parseGenerateOpts(
      args,
      'generate',
      readDefaultCollection(workspaceDefinition)
    );

    if (ws.isNxSchematic(opts.collectionName, opts.schematicName)) {
      const { schema, implementation } = ws.readSchematic(opts.collectionName, opts.schematicName);
      const combinedOpts = combineOptionsForSchematic(opts.schematicOptions, opts.collectionName, opts.schematicName, workspaceDefinition, schema);
      const host = new FsTree(root, isVerbose, logger);
      await implementation(combinedOpts)(host);
      const changes = host.listChanges();

      printChanges(changes);
      if (!opts.dryRun) {
        flushChanges(root, changes);
      } else {
        logger.warn(`\nNOTE: The "dryRun" flag means no changes were made.`);
      }

    } else {
      return (await import('./ngcli-adapter')).generate(logger, root, opts);
    }
  });
}
