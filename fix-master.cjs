const fs = require('fs');
const path = 'output/cv-master-presser.html';
let html = fs.readFileSync(path, 'utf8');
const masterText = 'Multidisciplinary professional with experience across municipal government, high-stakes testing, public education, and professional sports. Skilled in instruction and training, curriculum design, data analysis, program administration, and technology integration. Detail-oriented with a track record of accuracy and quality assurance, and the ability to communicate complex information clearly to diverse audiences. Effective in fast-paced, time-sensitive environments.';
// Find the summary-text div and replace its content
const idx = html.indexOf('<div class="summary-text">A versatile');
if (idx >= 0) {
  const end = html.indexOf('</div>', idx);
  html = html.substring(0, idx) + '<div class="summary-text">' + masterText + '</div>' + html.substring(end + 6);
  fs.writeFileSync(path, html, 'utf8');
  console.log('REPLACED at byte ' + idx);
} else {
  console.log('PATTERN NOT FOUND — checking alternate...');
  console.log('Contains Multidisciplinary:', html.includes('Multidisciplinary'));
}
console.log('Verification line:');
const lines = html.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('summary-text') && lines[i].includes('Multidisciplinary')) {
    console.log('LINE ' + (i+1) + ': ' + lines[i].trim().substring(0, 120));
  }
}
