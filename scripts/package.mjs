import { createHash } from 'node:crypto'
import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// Same dist + manifest + tar/sha256 flow as linkifier/config-sync. No signing/publishing.
const root = process.cwd()
const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf-8'))
const dist = join(root, 'dist')
await copyFile(join(root, 'plugin.json'), join(dist, 'plugin.json'))
const collected = []
async function walk (dir, prefix) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) await walk(join(dir, entry.name), rel)
        else if (entry.isFile()) collected.push(rel)
    }
}
await walk(dist, '')
collected.sort()
const tarball = `${manifest.id}-${manifest.version}.tgz`
const tarballPath = join(root, tarball)
const tar = spawnSync('tar', ['-czf', tarballPath, '-C', dist, ...collected], {
    stdio: 'inherit',
    shell: true,
})
if (tar.status !== 0) throw new Error(`tar 打包失败：exit ${tar.status}`)
const hash = createHash('sha256').update(await readFile(tarballPath)).digest('hex')
await writeFile(`${tarballPath}.sha256`, `${hash}  ${tarball}\n`, 'utf-8')
console.log(`打包完成：${tarball}`)
console.log(`sha256：${hash}`)
console.log('包含文件：')
for (const file of collected) console.log(`  ${file}`)
