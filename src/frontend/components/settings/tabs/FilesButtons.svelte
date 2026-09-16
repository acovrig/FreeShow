<script lang="ts">
    import { activePopup, special } from "../../../stores"
    import { save } from "../../../utils/save"
    import Icon from "../../helpers/Icon.svelte"
    import T from "../../helpers/T.svelte"
    import InputRow from "../../input/InputRow.svelte"
    import MaterialButton from "../../inputs/MaterialButton.svelte"
    import MaterialToggleSwitch from "../../inputs/MaterialToggleSwitch.svelte"

    function backup() {
        save(false, { backup: true, includeMedia: $special.backupIncludesMedia || false })
    }

    function toggleIncludeMedia(e: any) {
        special.update((a) => {
            if (!e.detail) delete a.backupIncludesMedia
            else a.backupIncludesMedia = true
            return a
        })
    }
</script>

<MaterialToggleSwitch label="settings.backup_include_media" title="settings.backup_include_media_tip" style="width: 100%;" checked={$special.backupIncludesMedia || false} defaultValue={false} on:change={toggleIncludeMedia} />

<InputRow>
    <MaterialButton style="flex: 1;font-size: 1.1em;padding: 20px !important;" title={$special.backupIncludesMedia ? "settings.backup_info_with_media" : "settings.backup_info"} on:click={backup}>
        <Icon id="export" size={1.3} />
        <p><T id="settings.backup_all" /></p>
    </MaterialButton>
    <MaterialButton style="flex: 1;font-size: 1.1em;padding: 20px !important;" on:click={() => activePopup.set("restore")}>
        <Icon id="import" size={1.3} />
        <p><T id="settings.restore" /></p>
    </MaterialButton>
</InputRow>
