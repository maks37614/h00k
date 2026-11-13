'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=name=>fs.readFileSync(path.join(root,'build',name));
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));

test('Windows app executable and both installer icons use generated robot',()=>{
  assert.equal(pkg.build.win.icon,'build/h00k.ico');
  assert.equal(pkg.build.nsis.installerIcon,'build/h00k.ico');
  assert.equal(pkg.build.nsis.uninstallerIcon,'build/h00k.ico');
  assert.equal(pkg.build.nsis.oneClick,false);
  assert.ok(pkg.scripts.predist.includes('brand-assets'));
  const icon=read('h00k.ico');
  assert.equal(icon.readUInt16LE(0),0);
  assert.equal(icon.readUInt16LE(2),1);
  const count=icon.readUInt16LE(4);
  assert.ok(count>=7,'multi-size icon for Start Menu and DPI scaling');
  const sizes=[];
  for(let i=0;i<count;i++){
    const at=6+i*16;
    const width=icon.readUInt8(at)||256, height=icon.readUInt8(at+1)||256;
    sizes.push(width);
    assert.equal(width,height);
    assert.equal(icon.readUInt16LE(at+6),32,'32bit icon');
    const size=icon.readUInt32LE(at+8),offset=icon.readUInt32LE(at+12);
    assert.ok(offset+size<=icon.length,'icon frame within file');
    assert.equal(icon.subarray(offset,offset+8).toString('hex'),'89504e470d0a1a0a','PNG-based ICO');
  }
  assert.ok(sizes.includes(16)&&sizes.includes(32)&&sizes.includes(48)&&sizes.includes(256));
});

test('assisted NSIS bitmaps use Windows compatible 24-bit RGB and correct dimensions',()=>{
  for(const [name,width,height] of [
    ['installerHeader.bmp',150,57],
    ['installerSidebar.bmp',164,314],
    ['uninstallerSidebar.bmp',164,314],
  ]){
    const file=read(name);
    assert.equal(file.subarray(0,2).toString(),'BM');
    assert.equal(file.readUInt32LE(2),file.length);
    assert.equal(file.readUInt16LE(28),24,'24bit BMP');
    assert.equal(file.readUInt32LE(30),0,'uncompressed BMP');
    assert.equal(file.readInt32LE(18),width);
    assert.equal(file.readInt32LE(22),height);
    assert.ok(file.length>20000);
  }
  const header=read('installerHeader.bmp');
  // Bright turquoise strip at the bottom of the h00k branded header.
  const stride=((150*3+3)&~3);
  const at=54+0*stride+18*3;
  assert.ok(header[at] >= 150,'blue channel in cyan header accent');
  assert.ok(header[at+1]>=100,'green channel in cyan header accent');
});

test('shortcut checkbox controls desktop link without changing start menu shortcut',()=>{
  const nsis=fs.readFileSync(path.join(root,'build','installer.nsh'),'utf8');
  for(const token of ['customWelcomePage','customInit','customPageAfterChangeDir',
    'NSD_CreateCheckbox','NSD_GetState','customInstall','newDesktopLink','oldDesktopLink']){
    assert.ok(nsis.includes(token),'NSIS missing '+token);
  }
  assert.match(nsis,/Delete "\$newDesktopLink"/);
  assert.doesNotMatch(nsis,/Delete "\$newStartMenuLink"/);
  assert.equal(pkg.build.nsis.createDesktopShortcut,true);
  assert.equal(pkg.build.nsis.createStartMenuShortcut,true);
});
