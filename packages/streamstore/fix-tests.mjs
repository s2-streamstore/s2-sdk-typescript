#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';
import { glob } from 'glob';

const files = glob.sync('src/tests/*.test.ts');

for (const file of files) {
  let content = readFileSync(file, 'utf-8');
  let modified = false;

  // Fix imports - ensure createStringRecord, createBytesRecord, createAppendInput are imported
  if (content.includes('import') && !content.includes('createStringRecord')) {
    // Add to existing index.js import
    content = content.replace(
      /from "\.\.\/index\.js"/,
      ', createStringRecord, createBytesRecord, createAppendInput } from "../index.js"'
    );
    content = content.replace(/^(import \{)/m, '$1 createStringRecord, createBytesRecord, createAppendInput,');
    modified = true;
  }

  // Fix matchSeqNum: 0 -> matchSeqNum: 0n
  if (content.match(/matchSeqNum:\s*0[,\s\}]/)) {
    content = content.replace(/matchSeqNum:\s*0([,\s\}])/g, 'matchSeqNum: 0n$1');
    modified = true;
  }

  // Fix writer.write({ body: "..." }) -> writer.write(createStringRecord({ body: "..." }))
  content = content.replace(
    /writer\.write\(\{\s*body:\s*"([^"]+)"\s*\}\)/g,
    'writer.write(createStringRecord({ body: "$1" }))'
  );

  // Fix session.submit([{ body: "..." }]) -> session.submit([createStringRecord({ body: "..." })])
  content = content.replace(
    /session\.submit\(\[\{\s*body:\s*"([^"]+)"\s*\}\]\)/g,
    'session.submit([createStringRecord({ body: "$1" })])'
  );

  // Fix stream.append([...]) -> stream.append(createAppendInput([...]))
  // But be careful not to double-wrap
  if (!content.includes('stream.append(createAppendInput')) {
    content = content.replace(
      /stream\.append\(\[/g,
      'stream.append(createAppendInput(['
    );
    // Add closing paren
    content = content.replace(
      /stream\.append\(createAppendInput\(\[[^\]]+\]\)\);/g,
      (match) => match.replace(/\]\)\);$/, ']));')
    );
  }

  if (modified || content !== readFileSync(file, 'utf-8')) {
    writeFileSync(file, content);
    console.log(`Fixed: ${file}`);
  }
}

console.log('Done!');
