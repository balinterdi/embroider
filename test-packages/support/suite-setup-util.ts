import { resolve } from 'path';
import execa from 'execa';

async function githubMatrix() {
  let dir = resolve(__dirname, '..', '..', 'tests', 'scenarios');
  let { stdout } = await execa(
    'scenario-tester',
    ['list', '--require', 'ts-node/register', '--files', '*-test.ts', '--matrix', 'yarn test --filter %s:'],
    {
      cwd: dir,
      preferLocal: true,
    }
  );

  let { include: suites } = JSON.parse(stdout) as { include: { name: string; command: string }[]; name: string[] };

  let include = [
    ...suites.map(s => ({
      name: `${s.name} ubuntu`,
      os: 'ubuntu',
      command: s.command,
      dir,
    })),
    ...suites
      .filter(s => s.name !== 'node') // TODO: node tests do not work under windows yet
      .map(s => ({
        name: `${s.name} windows`,
        os: 'windows',
        command: s.command,
        dir,
      })),
  ];

  return {
    name: include.map(s => s.name),
    include,
  };
}

async function main() {
  try {
    if (process.argv.includes('--matrix')) {
      const result = await githubMatrix();

      process.stdout.write(JSON.stringify(result));
    }
  } catch (error) {
    console.error(error);
    process.exitCode = -1;
  }
}

if (require.main === module) {
  main();
}
