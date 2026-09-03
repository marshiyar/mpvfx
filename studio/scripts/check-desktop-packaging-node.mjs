const major = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);

if (major !== 22) {
  console.error(
    `Electron packaging requires Node 22 LTS (found ${process.version}). Run \"nvm use\" in studio first.`,
  );
  process.exit(1);
}
