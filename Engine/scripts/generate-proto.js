const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PROTO_DIR = path.resolve(__dirname, '..', 'WAProto');

// Recursively collect all `.proto` files
function getProtoFiles(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });

  return files
    .flatMap((file) => {
      const filePath = path.join(dir, file.name);
      return file.isDirectory() ? getProtoFiles(filePath) : filePath;
    })
    .filter((file) => file.endsWith('.proto'));
}

const protoFiles = getProtoFiles(PROTO_DIR);
if (protoFiles.length === 0) {
  console.error('No .proto files found in the proto directory.');
  process.exit(1);
}

console.log(`Found ${protoFiles.length} proto files. Cleaning...`);

// Pass 1: Clean all files
protoFiles.forEach((file) => {
  try {
    let content = fs.readFileSync(file, 'utf8');

    // 1. Ensure proto3 syntax
    if (/syntax\s*=/.test(content)) {
      content = content.replace(/syntax\s*=\s*"[^"]+"/i, 'syntax = "proto3";');
    } else {
      content = `syntax = "proto3";\n${content}`;
    }

    // 2. Clean duplicated semicolons
    content = content.replace(/;;+/g, ';');

    // 3. Replace "required" with "optional"
    // Handle both cases: "required type field" and "required field" (if type is missing or something)
    // We use a more robust regex that handles any whitespace
    content = content.replace(/\brequired\s+/g, 'optional ');

    fs.writeFileSync(file, content, 'utf8');
  } catch (err) {
    console.error(`Error cleaning ${file}: ${err.message}`);
  }
});

console.log("Cleaning complete. Generating JS...");

// Pass 2: Generate JS
protoFiles.forEach((file) => {
  const fileName = path.basename(file);
  const outputJS = file.replace(/\.proto$/, '.js');

  console.log(`Generating JS for ${fileName}...`);

  const pbjsCommand = [
    `npx pbjs`,
    `-t static-module`,
    `-w commonjs`,
    `-o "${outputJS}"`,
    `"${file}"`
  ].join(' ');

  try {
    execSync(pbjsCommand, { stdio: 'pipe' });
  } catch (err) {
    console.error(`PBJS FAILED: ${file}`);
    console.error("STDOUT:", err.stdout?.toString());
    console.error("STDERR:", err.stderr?.toString());
  }
});

console.log("DONE.");