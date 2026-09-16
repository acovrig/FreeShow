// ----- FreeShow -----
// Sync shows, projects & media with a chosen local folder (e.g. one managed by Dropbox/OneDrive/Google Drive)

import path from "path"
import { Main } from "../../types/IPC/Main"
import { ToMain } from "../../types/IPC/ToMain"
import type { Show } from "../../types/Show"
import { _store, setStore } from "../data/store"
import { sendMain, sendToMain } from "../IPC/main"
import {
    copyFileAsync,
    createFolder,
    deleteFile,
    doesPathExist,
    doesPathExistAsync,
    getAllReferencedMediaPaths,
    getDataFolderPath,
    getFileParentFolderId,
    getFileStats,
    getMediaSyncFolderPath,
    parseShow,
    readFileAsync,
    readFolder,
    resolveReferencedMediaPath,
    writeFileAsync
} from "./files"
import { refreshAllShows } from "./shows"

const isShowFile = (name: string) => name.toLowerCase().endsWith(".show")
const isDirectory = (folderPath: string) => !!getFileStats(folderPath, true)?.folder

interface SyncFolderData {
    folderPath: string
    deleteMissing: boolean
    includeMedia: boolean
}
interface SyncFolderResult {
    success: boolean
    error?: "no_folder"
    copied: number
    deleted: number
}

// copy shows, projects & (optionally) media from the app's data folders to the chosen local folder
export async function syncToFolder({ folderPath, deleteMissing, includeMedia }: SyncFolderData): Promise<SyncFolderResult> {
    if (!folderPath) return { success: false, error: "no_folder", copied: 0, deleted: 0 }

    let copied = 0
    let deleted = 0

    // shows
    const showsPath = getDataFolderPath("shows")
    const showsTarget = createFolder(path.join(folderPath, "Shows"))
    const sourceShowFiles = readFolder(showsPath).filter(isShowFile)
    copied += (await copyFiles(showsPath, showsTarget, sourceShowFiles)).copied
    if (deleteMissing) deleted += await removeFilesNotIn(showsTarget, sourceShowFiles, isShowFile)

    // projects (single portable store file, always overwritten wholesale)
    if (await copyProjectsStore(createFolder(path.join(folderPath, "Projects")), "to")) copied++

    // media
    if (includeMedia) {
        const mediaTarget = createFolder(path.join(folderPath, "Media"))
        const mediaResult = await syncMediaToFolder(mediaTarget, deleteMissing)
        copied += mediaResult.copied
        deleted += mediaResult.deleted
    }

    return { success: true, copied, deleted }
}

// copy shows, projects & (optionally) media from the chosen local folder into the app's data folders
export async function syncFromFolder({ folderPath, deleteMissing, includeMedia }: SyncFolderData): Promise<SyncFolderResult> {
    if (!folderPath || !doesPathExist(folderPath)) return { success: false, error: "no_folder", copied: 0, deleted: 0 }

    let copied = 0
    let deleted = 0
    let showsChanged = false

    // shows
    const showsPath = getDataFolderPath("shows")
    const showsSource = path.join(folderPath, "Shows")
    let changedShows: [string, Show][] = []
    if (doesPathExist(showsSource)) {
        const sourceShowFiles = readFolder(showsSource).filter(isShowFile)

        const showsResult = await copyFiles(showsSource, showsPath, sourceShowFiles, true)
        copied += showsResult.copied
        changedShows = showsResult.changedShows
        if (showsResult.copied) showsChanged = true

        if (deleteMissing) {
            const showsDeleted = await removeFilesNotIn(showsPath, sourceShowFiles, isShowFile)
            deleted += showsDeleted
            if (showsDeleted) showsChanged = true
        }
    }

    // projects
    if (await copyProjectsStore(path.join(folderPath, "Projects"), "from")) copied++

    // media (additive only - the app's shared media folder can hold media referenced by other shows too)
    if (includeMedia) {
        const mediaSource = path.join(folderPath, "Media")
        if (doesPathExist(mediaSource)) copied += await syncMediaFromFolder(mediaSource)
    }

    if (showsChanged) refreshAllShows()
    // a show that's already loaded in a running app's memory (open, or just sitting in a project list) is never
    // re-read from disk on its own - push the fresh content directly so a sync doesn't leave a stale version on screen
    if (changedShows.length) sendToMain(ToMain.SHOWS_UPDATED, { shows: changedShows })

    return { success: true, copied, deleted }
}

async function copyFiles(sourceFolder: string, targetFolder: string, fileNames: string[], validateAsShow = false) {
    let copied = 0
    const changedShows: [string, Show][] = []

    for (const name of fileNames) {
        const content = await readFileAsync(path.join(sourceFolder, name))
        if (!content) continue

        // skip files that aren't valid FreeShow show files when importing from an external folder
        let parsedShow: [string, Show] | null = null
        if (validateAsShow) {
            parsedShow = parseShow(content)
            if (!parsedShow) continue
        }

        const wasWritten = await writeFileAsync(path.join(targetFolder, name), content)
        if (wasWritten) {
            copied++
            if (parsedShow) changedShows.push(parsedShow)
        }
    }

    return { copied, changedShows }
}

// delete files in a folder that have no matching name in `keepNames`
async function removeFilesNotIn(folderPath: string, keepNames: string[], filter: (name: string) => boolean) {
    const keep = new Set(keepNames)
    const existingFiles = readFolder(folderPath).filter(filter)

    let deleted = 0
    for (const name of existingFiles) {
        if (keep.has(name)) continue
        if (deleteFile(path.join(folderPath, name))) deleted++
    }

    return deleted
}

async function copyProjectsStore(targetFolder: string, direction: "to" | "from") {
    const projectsFileName = "projects.json"

    if (direction === "to") {
        const store = _store.PROJECTS
        if (!store) return false

        const content = await readFileAsync(store.path)
        if (!content) return false

        return writeFileAsync(path.join(targetFolder, projectsFileName), content)
    }

    const sourceFile = path.join(targetFolder, projectsFileName)
    if (!doesPathExist(sourceFile)) return false

    const content = await readFileAsync(sourceFile)
    if (!content || !isValidJSON(content)) return false

    const data = JSON.parse(content)
    setStore(_store.PROJECTS, data)
    sendMain(Main.PROJECTS, data)

    return true
}

function isValidJSON(content: string) {
    try {
        JSON.parse(content)
        return true
    } catch {
        return false
    }
}

// MEDIA
// stored/read under the same folderId/fileName layout the media sync folder uses,
// so the existing "locate missing media" lookup can find media that came from a sync

async function syncMediaToFolder(mediaTarget: string, deleteMissing: boolean) {
    const referencedPaths = getAllReferencedMediaPaths()
    const keepRelativePaths: string[] = []
    let copied = 0

    for (const mediaPath of referencedPaths) {
        const resolvedPath = resolveReferencedMediaPath(mediaPath)
        if (!resolvedPath) continue

        const relative = path.join(getFileParentFolderId(mediaPath), path.basename(mediaPath))
        keepRelativePaths.push(relative)

        if (await copyMediaFile(resolvedPath, path.join(mediaTarget, relative))) copied++
    }

    const deleted = deleteMissing ? await removeMediaFilesNotIn(mediaTarget, keepRelativePaths) : 0

    return { copied, deleted }
}

async function syncMediaFromFolder(mediaSource: string) {
    const mediaTargetRoot = getMediaSyncFolderPath()
    let copied = 0

    const folderIds = readFolder(mediaSource).filter((name) => isDirectory(path.join(mediaSource, name)))
    for (const folderId of folderIds) {
        const sourceFolderPath = path.join(mediaSource, folderId)
        const fileNames = readFolder(sourceFolderPath)

        for (const fileName of fileNames) {
            const sourceFile = path.join(sourceFolderPath, fileName)
            const destFile = path.join(mediaTargetRoot, folderId, fileName)
            if (await copyMediaFile(sourceFile, destFile)) copied++
        }
    }

    return copied
}

async function copyMediaFile(sourcePath: string, destPath: string) {
    if (await doesPathExistAsync(destPath)) return false

    createFolder(path.dirname(destPath))
    return copyFileAsync(sourcePath, destPath)
}

async function removeMediaFilesNotIn(mediaTarget: string, keepRelativePaths: string[]) {
    const keep = new Set(keepRelativePaths)
    let deleted = 0

    const folderIds = readFolder(mediaTarget).filter((name) => isDirectory(path.join(mediaTarget, name)))
    for (const folderId of folderIds) {
        const folderPath = path.join(mediaTarget, folderId)

        for (const fileName of readFolder(folderPath)) {
            const relative = path.join(folderId, fileName)
            if (keep.has(relative)) continue
            if (deleteFile(path.join(folderPath, fileName))) deleted++
        }
    }

    return deleted
}
