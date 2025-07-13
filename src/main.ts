import { Plugin, TFile, moment, Notice } from 'obsidian'
import { DEFAULT_SETTINGS, FrontmatterModifiedSettings, FrontmatterModifiedSettingTab } from './settings'
import { utimes, access, constants } from 'fs'
import { promisify } from 'util'
import { join, normalize } from 'path'
import { exec } from 'child_process'

const utimesAsync = promisify(utimes)
const accessAsync = promisify(access)
const execAsync = promisify(exec)

export default class FrontmatterModified extends Plugin {
  settings: FrontmatterModifiedSettings
  timer: { [key: string]: number } = {}

  async onload () {
    await this.loadSettings()

    if (!this.settings.useKeyupEvents) {
      /*
       * This is the default mode, where we watch for a change in the editor and then
       * update the frontmatter.
       *
       * For users who experience issues due to external programs modifying their files,
       * they can use the special 'useKeyupEvents' mode below.
       *
       * The reason for using workspace.on('editor-change') rather than vault.on('modify')
       * is that vault.modify triggers when the file timestamp is updated. This means that
       * many sync clients will cause all files to trigger as if they'd been updated,
       * when no actual changes were made to the file.
       */
      this.registerEvent(this.app.workspace.on('editor-change', (_editor, info) => {
        if (info.file instanceof TFile) {
          this.updateFrontmatter(info.file)
        }
      }))
    } else if (this.settings.useKeyupEvents) {
      /*
       * This is a special mode for users who can't rely on Obsidian detecting file changes.
       * Both of these built-in events fire when a file is externally modified:
       *
       * app.vault.on('modify')
       * app.workspace.on('editor-change')
       *
       * This apparently causes issues for people with iCloud, as Obsidian is constantly
       * firing these events when files sync.
       *
       * See this comment: https://forum.obsidian.md/t/51776/20
       * And this thread: https://forum.obsidian.md/t/14874
       *
       * The way I am doing this is probably a "bad" way. Anyone who knows the best practice
       * here, please let me know! It works just fine but perhaps there's a better way.
       */

      // Watch for typing events
      this.registerDomEvent(document, 'input', (event: InputEvent) => {
        // Check to see if the inputted key is a single, visible Unicode character.
        // This is to prevent matching arrow keys, etc. Using Unicode is necessary
        // to match on emoji and other 2-byte characters.
        if (/^.$/u.test(event.data || '')) {
          this.handleTypingEvent(event)
        }
      })
      // Watch for clipboard paste
      this.registerDomEvent(document, 'paste', (event: ClipboardEvent) => { this.handleTypingEvent(event) })
    }

    this.addSettingTab(new FrontmatterModifiedSettingTab(this.app, this))

    // Add command to update OS timestamps for entire vault
    this.addCommand({
      id: 'update-all-os-timestamps',
      name: 'Update OS timestamps for all vault notes',
      callback: () => {
        this.updateAllOSTimestamps()
      }
    })
  }

  /**
   * Receive a typing event and initiate the frontmatter update process
   */
  handleTypingEvent (event: InputEvent | ClipboardEvent) {
    try {
      if ((event?.target as HTMLElement)?.closest('.markdown-source-view > .cm-editor')) {
        const file = this.app.workspace.getActiveFile()
        if (file instanceof TFile) {
          this.updateFrontmatter(file).then()
        }
      }
    } catch (e) {
      console.log(e)
    }
  }

  async loadSettings () {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
  }

  async saveSettings () {
    await this.saveData(this.settings)
  }

  /**
   * Use a timeout to update the metadata only once the user has stopped typing.
   * If the user keeps typing, then it will reset the timeout and start again from zero.
   *
   * Obsidian doesn't appear to correctly handle this situation otherwise, and pops an
   * error to say "<File> has been modified externally, merging changes automatically."
   *
   * @param {TFile} file
   */
  async updateFrontmatter (file: TFile) {
    clearTimeout(this.timer[file.path])
    this.timer[file.path] = window.setTimeout(() => {
      const cache = this.app.metadataCache.getFileCache(file)
      if (this.settings.onlyUpdateExisting && !cache?.frontmatter?.hasOwnProperty(this.settings.frontmatterProperty)) {
        // The user has chosen to only update the frontmatter property IF it already exists

      } else if (cache?.frontmatter?.[this.settings.excludeField]) {
        // This file has been excluded by YAML field

      } else if (this.settings.excludedFolders.some(folder => file.path.startsWith(folder + '/'))) {
        // This folder is in the exclusion list

      } else {
        // Update the modified date field

        const now = moment()
        const isAppendArray = this.settings.storeHistoryLog || cache?.frontmatter?.[this.settings.appendField] === true
        const desc = this.settings.historyNewestFirst
        let secondsSinceLastUpdate = Infinity
        let previousEntryMoment
        if (cache?.frontmatter?.[this.settings.frontmatterProperty]) {
          let previousEntry = cache?.frontmatter?.[this.settings.frontmatterProperty]
          if (isAppendArray && Array.isArray(previousEntry)) {
            // If we are using an array of updates, get the last item in the list
            previousEntry = previousEntry[desc ? 0 : previousEntry.length - 1]
          }
          // Get the length of time since the last update. Use a strict moment
          previousEntryMoment = moment(previousEntry, this.settings.momentFormat)
          if (previousEntryMoment.isValid()) {
            secondsSinceLastUpdate = now.diff(previousEntryMoment, 'seconds')
          }
        }

        // We will only update if it's been at least 30 seconds since the last recorded time. We do this
        // as a preventative measure against a race condition where two devices have the same note open
        // and are both syncing and updating each other.
        // Are we appending to an array of entries?
        if (secondsSinceLastUpdate > 30) {
          type StringOrInteger = string | number
          let newEntry: StringOrInteger | StringOrInteger[] = this.formatFrontmatterDate(now)

          if (isAppendArray) {
            let entries = cache?.frontmatter?.[this.settings.frontmatterProperty] || []
            if (!Array.isArray(entries)) entries = [entries] // In the case where the single previous entry was a string
            // We are using an array of entries. We need to check whether we want to replace the last array
            // entry (e.g. it is within the same timeframe unit), or we want to append a new entry
            if (entries.length) {
              if (previousEntryMoment && now.isSame(previousEntryMoment, this.settings.appendMaximumFrequency)) {
                // Same timeframe as the previous entry - replace it
                entries[desc ? 0 : entries.length - 1] = newEntry
              } else {
                desc ? entries.unshift(newEntry) : entries.push(newEntry)
              }
              // Trim the array if needed
              if (this.settings.historyMaxItems && entries.length > this.settings.historyMaxItems) {
                entries = desc ? entries.slice(0, this.settings.historyMaxItems) : entries.slice(-this.settings.historyMaxItems)
              }
            } else {
              entries.push(newEntry)
            }
            newEntry = entries
          }

          // Update the frontmatter
          this.app.fileManager.processFrontMatter(file, frontmatter => {
            // Update the modified date field
            frontmatter[this.settings.frontmatterProperty] = newEntry

            // Create a created date field if requested
            if (!this.settings.onlyUpdateExisting && this.settings.createdDateProperty && !frontmatter[this.settings.createdDateProperty]) {
              frontmatter[this.settings.createdDateProperty] = this.formatFrontmatterDate(moment(file.stat.ctime || now))
            }

            if (this.settings.createdDateProperty && frontmatter[this.settings.createdDateProperty]) {
              const createdDate = moment(frontmatter[this.settings.createdDateProperty], this.settings.momentFormat);
              const tag = createdDate.format('YYYY/MM/DD');
              if (!frontmatter.tags) {
                frontmatter.tags = [];
              }
              if (!frontmatter.tags.includes(tag)) {
                frontmatter.tags.push(tag);
              }

              // Update OS file timestamp if enabled and created date is valid
              this.updateOSFileTimestamp(file, createdDate);
            }
          })
        }
      }
    }, this.settings.timeout * 1000)
  }

  /**
   * Outputs the date in the user's specified MomentJS format.
   * If that format evalutes to an integer it will return an integer,
   * otherwise a string.
   */
  formatFrontmatterDate (date: moment.Moment): string | number {
    const output = date.format(this.settings.momentFormat)
    if (output.match(/^\d+$/)) {
      // The date is numeric/integer format
      return parseInt(output, 10)
    } else {
      return output
    }
  }

  /**
   * Update the OS file creation timestamp to match the created date from frontmatter
   * @param {TFile} file - The file to update
   * @param {moment.Moment} createdDate - The created date from frontmatter
   */
  async updateOSFileTimestamp (file: TFile, createdDate: moment.Moment) {
    // Only proceed if created date is valid and we have a created date property configured
    if (!this.settings.createdDateProperty || !createdDate.isValid()) {
      return
    }

    // Get the full file path by accessing the vault adapter
    const adapter = this.app.vault.adapter as any
    let filePath: string = 'unknown'

    try {
      // Try different methods to get the base path
      if (adapter.basePath) {
        // Most common case - FileSystemAdapter has basePath
        filePath = normalize(join(adapter.basePath, file.path))
      } else if (adapter.path?.basePath) {
        // Alternative path structure
        filePath = normalize(join(adapter.path.basePath, file.path))
      } else {
        // Last resort: try to parse from resource path
        const resourcePath = this.app.vault.getResourcePath(file)
        if (resourcePath.startsWith('file://')) {
          filePath = decodeURIComponent(resourcePath.slice(7))
        } else {
          filePath = resourcePath
        }
        filePath = normalize(filePath)
      }

      // Check if file exists before attempting to update timestamp
      await accessAsync(filePath, constants.F_OK)

      // Get current file stats for comparison
      const currentCreatedTime = file.stat.ctime
      const currentModifiedTime = file.stat.mtime
      const newCreatedTimestamp = createdDate.toDate().getTime()

      // Calculate time difference in hours
      const timeDifferenceMs = Math.abs(newCreatedTimestamp - currentCreatedTime)
      const timeDifferenceHours = timeDifferenceMs / (1000 * 60 * 60)

      // Skip update if time difference is less than 12 hours
      if (timeDifferenceHours < 12) {
        new Notice(
          `⏭️ Skipped OS timestamp update for "${file.name}"\n` +
          `⏰ Time difference: ${Math.round(timeDifferenceHours * 100) / 100} hours\n` +
          `📏 Threshold: 12 hours minimum\n` +
          `💾 Full path: ${filePath}`,
          4000
        )
        console.log(`Skipped OS timestamp update for ${file.path}: time difference ${timeDifferenceHours.toFixed(2)} hours < 12 hours threshold`)
        return
      }

      // Update file creation timestamp using platform-specific method
      await this.updateFileCreationTime(filePath, createdDate)

      // Also update access time to match creation time, keep modification time unchanged
      const createdTimestampSeconds = newCreatedTimestamp / 1000
      const currentModifiedTimeSeconds = currentModifiedTime / 1000
      await utimesAsync(filePath, createdTimestampSeconds, currentModifiedTimeSeconds)

      // Create detailed notification message using already calculated time difference
      const daysDifference = Math.floor(timeDifferenceHours / 24)
      const remainingHours = Math.floor(timeDifferenceHours % 24)
      const minutesDifference = Math.floor((timeDifferenceHours % 1) * 60)

      let timeDiffText = ''
      if (daysDifference > 0) {
        timeDiffText = `${daysDifference}d ${remainingHours}h ${minutesDifference}m`
      } else if (remainingHours > 0) {
        timeDiffText = `${remainingHours}h ${minutesDifference}m`
      } else if (minutesDifference > 0) {
        timeDiffText = `${minutesDifference}m`
      } else {
        timeDiffText = 'less than 1m'
      }

      const direction = newCreatedTimestamp < currentCreatedTime ? 'earlier' : 'later'
      const formattedDate = createdDate.format('YYYY-MM-DD HH:mm:ss')

      // Show detailed success notification with full path
      new Notice(
        `✅ OS timestamp updated for "${file.name}"\n` +
        `📅 New creation time: ${formattedDate}\n` +
        `⏰ Adjusted ${timeDiffText} ${direction} than original\n` +
        `📁 Vault path: ${file.path}\n` +
        `💾 Full path: ${filePath}`,
        7000
      )

      console.log(`Successfully updated OS file timestamp for ${file.path} to ${formattedDate}`)
    } catch (error) {
      // Show detailed error notification with full path
      const errorMessage = error instanceof Error ? error.message : String(error)
      new Notice(
        `❌ Failed to update OS timestamp for "${file.name}"\n` +
        `🚫 Error: ${errorMessage}\n` +
        `📁 Vault path: ${file.path}\n` +
        `💾 Full path: ${filePath}\n` +
        `💡 Check file permissions and path validity`,
        9000
      )
      console.error(`Failed to update OS file timestamp for ${file.path}:`, error)
    }
  }

  /**
   * Update OS file timestamp silently (for batch operations)
   * @param {TFile} file - The file to update
   * @param {moment.Moment} createdDate - The created date from frontmatter
   * @returns {Promise<string>} - 'updated', 'skipped_threshold', or throws error
   */
  async updateOSFileTimestampSilent(file: TFile, createdDate: moment.Moment): Promise<string> {
    // Only proceed if created date is valid and we have a created date property configured
    if (!this.settings.createdDateProperty || !createdDate.isValid()) {
      throw new Error('Invalid configuration or date')
    }

    // Get the full file path by accessing the vault adapter
    const adapter = this.app.vault.adapter as any
    let filePath: string = 'unknown'

    // Try different methods to get the base path
    if (adapter.basePath) {
      // Most common case - FileSystemAdapter has basePath
      filePath = normalize(join(adapter.basePath, file.path))
    } else if (adapter.path?.basePath) {
      // Alternative path structure
      filePath = normalize(join(adapter.path.basePath, file.path))
    } else {
      // Last resort: try to parse from resource path
      const resourcePath = this.app.vault.getResourcePath(file)
      if (resourcePath.startsWith('file://')) {
        filePath = decodeURIComponent(resourcePath.slice(7))
      } else {
        filePath = resourcePath
      }
      filePath = normalize(filePath)
    }

    // Check if file exists before attempting to update timestamp
    await accessAsync(filePath, constants.F_OK)

    // Get current file stats for comparison
    const currentCreatedTime = file.stat.ctime
    const currentModifiedTime = file.stat.mtime
    const newCreatedTimestamp = createdDate.toDate().getTime()

    // Calculate time difference in hours
    const timeDifferenceMs = Math.abs(newCreatedTimestamp - currentCreatedTime)
    const timeDifferenceHours = timeDifferenceMs / (1000 * 60 * 60)

    // Skip update if time difference is less than 12 hours
    if (timeDifferenceHours < 12) {
      return 'skipped_threshold'
    }

    // Update file creation timestamp using platform-specific method
    await this.updateFileCreationTime(filePath, createdDate)

    // Also update access time to match creation time, keep modification time unchanged
    const createdTimestampSeconds = newCreatedTimestamp / 1000
    const currentModifiedTimeSeconds = currentModifiedTime / 1000
    await utimesAsync(filePath, createdTimestampSeconds, currentModifiedTimeSeconds)

    return 'updated'
  }

  /**
   * Update file creation time using platform-specific methods
   * @param {string} filePath - The full file system path
   * @param {moment.Moment} createdDate - The target creation date
   */
  async updateFileCreationTime(filePath: string, createdDate: moment.Moment) {
    // Detect platform and use appropriate command
    const platform = process.platform

    if (platform === 'win32') {
      // Windows: Use PowerShell to update creation time
      // Escape the file path and use proper PowerShell syntax
      const escapedPath = filePath.replace(/'/g, "''")
      const dateString = createdDate.format('YYYY-MM-DD HH:mm:ss')

      // Use PowerShell with proper escaping and explicit DateTime constructor
      try {
        // Create a simpler, more reliable PowerShell command
        const powershellScript = `try { $file = Get-Item -LiteralPath '${escapedPath}' -ErrorAction Stop; $newDate = [DateTime]::ParseExact('${dateString}', 'yyyy-MM-dd HH:mm:ss', $null); $file.CreationTime = $newDate; Write-Output 'Success: Updated creation time' } catch { Write-Error $_.Exception.Message; exit 1 }`

        await execAsync(`powershell -Command "${powershellScript}"`)
      } catch (psError) {
        // If PowerShell fails, provide detailed error information
        console.log('PowerShell method failed, no fallback available for Windows creation time update')
        throw new Error(`PowerShell failed: ${psError.message}. File path: ${filePath}. Target date: ${dateString}`)
      }
    } else if (platform === 'darwin') {
      // macOS: Use SetFile command if available, otherwise touch
      try {
        const timestamp = createdDate.format('MM/DD/YYYY HH:mm:ss')
        await execAsync(`SetFile -d "${timestamp}" "${filePath}"`)
      } catch {
        // Fallback to touch if SetFile is not available
        const touchTimestamp = createdDate.format('YYYYMMDDHHmm.ss')
        await execAsync(`touch -t ${touchTimestamp} "${filePath}"`)
      }
    } else {
      // Linux/Unix: Use touch command (note: this updates modification time, not creation time)
      const touchTimestamp = createdDate.format('YYYYMMDDHHmm.ss')
      await execAsync(`touch -t ${touchTimestamp} "${filePath}"`)
    }
  }

  /**
   * Update OS timestamps for all notes in the vault that have created dates
   */
  async updateAllOSTimestamps() {
    // Only proceed if created date property is configured
    if (!this.settings.createdDateProperty) {
      new Notice(
        `❌ Cannot update OS timestamps\n` +
        `⚙️ No created date property configured\n` +
        `💡 Please set a created date property in plugin settings first`,
        6000
      )
      return
    }

    // Get all markdown files in the vault
    const allFiles = this.app.vault.getMarkdownFiles()

    // Show initial notification
    new Notice(
      `🔄 Starting OS timestamp update for entire vault\n` +
      `📁 Found ${allFiles.length} markdown files\n` +
      `⏳ This may take a while...`,
      4000
    )

    let processedCount = 0
    let updatedCount = 0
    let skippedThresholdCount = 0
    let errorCount = 0
    const errors: string[] = []

    // Process files in batches to avoid overwhelming the system
    const batchSize = 10
    for (let i = 0; i < allFiles.length; i += batchSize) {
      const batch = allFiles.slice(i, i + batchSize)

      // Process batch concurrently
      await Promise.allSettled(
        batch.map(async (file) => {
          try {
            processedCount++

            // Get file cache to check for created date
            const cache = this.app.metadataCache.getFileCache(file)
            const createdDateValue = cache?.frontmatter?.[this.settings.createdDateProperty]

            if (createdDateValue) {
              const createdDate = moment(createdDateValue, this.settings.momentFormat)
              if (createdDate.isValid()) {
                const result = await this.updateOSFileTimestampSilent(file, createdDate)
                if (result === 'updated') {
                  updatedCount++
                } else if (result === 'skipped_threshold') {
                  skippedThresholdCount++
                }
              } else {
                errors.push(`${file.path}: Invalid date format`)
                errorCount++
              }
            }
            // Skip files without created date (not counted as errors)
          } catch (error) {
            errorCount++
            const errorMsg = error instanceof Error ? error.message : String(error)
            errors.push(`${file.path}: ${errorMsg}`)
          }
        })
      )

      // Show progress notification every few batches
      if (i % (batchSize * 3) === 0 && i > 0) {
        new Notice(
          `⏳ Progress: ${processedCount}/${allFiles.length} files processed\n` +
          `✅ Updated: ${updatedCount} files\n` +
          `❌ Errors: ${errorCount} files`,
          2000
        )
      }
    }

    // Show final summary notification
    const successRate = allFiles.length > 0 ? Math.round((updatedCount / allFiles.length) * 100) : 0

    new Notice(
      `🎉 Vault OS timestamp update completed!\n` +
      `📊 Total files: ${allFiles.length}\n` +
      `✅ Successfully updated: ${updatedCount}\n` +
      `⏭️ Skipped (no created date): ${processedCount - updatedCount - skippedThresholdCount - errorCount}\n` +
      `⏰ Skipped (< 12h difference): ${skippedThresholdCount}\n` +
      `❌ Errors: ${errorCount}\n` +
      `📈 Success rate: ${successRate}%` +
      (errorCount > 0 ? `\n💡 Check console for error details` : ''),
      8000
    )

    // Log detailed errors to console if any
    if (errors.length > 0) {
      console.group('OS Timestamp Update Errors:')
      errors.forEach(error => console.error(error))
      console.groupEnd()
    }

    console.log(`Vault OS timestamp update completed: ${updatedCount}/${allFiles.length} files updated successfully`)
  }
}
