//! The developer disk image (DDI) over an RSD tunnel: whether the phone offers displayservice, which
//! input and streaming need, and installing the DDI cryptex through cryptexd, the same way Xcode and
//! `pymobiledevice3 cryptex auto-install` do. Everything runs over the RemotePairing tunnel the helper
//! already holds, so a phone paired only over Wi-Fi needs no USB cable for it. Apple personalizes the
//! image for this phone (a TSS ticket from gs.apple.com), so the computer needs internet access.
use idevice::{
    IdeviceError, ReadWrite, RsdService,
    provider::RsdProvider,
    rsd::RsdHandshake,
    services::cryptexd::{
        Cryptex1Assets, CryptexInstallRequest, CryptexdClient, InstalledCryptex, installed_ddi,
    },
    tss::TSSRequest,
};
use serde_json::{Value, json};
use std::path::Path;

pub const DISPLAY_SERVICE: &str = "com.apple.coredevice.displayservice";
const CRYPTEXD_SERVICE: &str = "com.apple.security.cryptexd.remote";

/// Which step of an installation failed. The daemon turns each into its own advice: only `install`
/// failures suggest connecting USB once, since USB needs the same image and the same Apple ticket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    /// The local image directory is missing or unreadable.
    Image,
    /// The phone offers no cryptexd over this tunnel.
    Unavailable,
    /// Apple's signing server refused or could not be reached.
    Signing,
    /// cryptexd rejected or failed the installation.
    Install,
}

impl Stage {
    fn name(self) -> &'static str {
        match self {
            Stage::Image => "image",
            Stage::Unavailable => "unavailable",
            Stage::Signing => "signing",
            Stage::Install => "install",
        }
    }
}

fn installed_json(installed: &Option<InstalledCryptex>) -> Value {
    installed
        .as_ref()
        .map(|c| json!({"identifier": c.identifier, "version": c.version}))
        .unwrap_or(Value::Null)
}

pub async fn status(provider: &mut impl RsdProvider, rsd: &mut RsdHandshake) -> Value {
    let display_service = rsd.services.contains_key(DISPLAY_SERVICE);
    let cryptexd = rsd.services.contains_key(CRYPTEXD_SERVICE);
    let installed = if cryptexd {
        installed_ddi(provider, rsd)
            .await
            .map_err(|e| e.to_string())
    } else {
        Ok(None)
    };
    json!({
        "display_service": display_service,
        "cryptexd": cryptexd,
        "ddi": installed.as_ref().map(installed_json).unwrap_or(Value::Null),
        "ddi_error": installed.err(),
    })
}

fn failed(stage: Stage, error: impl std::fmt::Display) -> Value {
    json!({"installed": false, "stage": stage.name(), "error": error.to_string()})
}

async fn client(
    provider: &mut impl RsdProvider,
    rsd: &mut RsdHandshake,
) -> Result<CryptexdClient<Box<dyn ReadWrite>>, IdeviceError> {
    CryptexdClient::connect_rsd(provider, rsd).await
}

/// Installs the DDI from `restore_dir` (a directory with BuildManifest.plist and its payloads) unless
/// one is installed already. The reply's `installed` says whether a DDI is now in place; a failure
/// names its `stage`. The caller reconnects afterwards: the handshake's service list predates it.
pub async fn install(
    provider: &mut impl RsdProvider,
    rsd: &mut RsdHandshake,
    restore_dir: &str,
    force: bool,
) -> Value {
    if !rsd.services.contains_key(CRYPTEXD_SERVICE) {
        return failed(
            Stage::Unavailable,
            "The iPhone offers no cryptexd over this connection (it needs iOS 26.4 or newer).",
        );
    }
    let assets = match Cryptex1Assets::load(Path::new(restore_dir)).await {
        Ok(assets) => assets,
        Err(error) => {
            return failed(
                Stage::Image,
                format!("Cannot read the developer disk image in {restore_dir}: {error}"),
            );
        }
    };
    if !force {
        match installed_ddi(provider, rsd).await {
            Ok(Some(installed)) => {
                return json!({"installed": true, "already": true, "ddi": installed_json(&Some(installed))});
            }
            Ok(None) => {}
            Err(error) => return failed(Stage::Install, error),
        }
    }
    let domain = match assets.nonce_domain() {
        Ok(domain) => domain,
        Err(error) => return failed(Stage::Image, error),
    };
    let identifiers = match async {
        client(provider, rsd)
            .await?
            .read_personalization_identifiers()
            .await
    }
    .await
    {
        Ok(identifiers) => identifiers,
        Err(error) => return failed(Stage::Install, error),
    };
    let nonce = match async { client(provider, rsd).await?.cryptex_nonce(domain).await }.await {
        Ok(nonce) => nonce,
        Err(error) => return failed(Stage::Install, error),
    };
    let mut request = TSSRequest::new();
    if let Err(error) = request.add_cryptex1_tags(&assets.build_identity, &identifiers, &nonce) {
        return failed(Stage::Image, error);
    }
    let ticket = match request.send().await {
        Ok(response) => response
            .into_dictionary()
            .and_then(|response| {
                // Cryptex1 responses carry the ticket under their own key on current releases and
                // under the AP key on older ones.
                response
                    .get("Cryptex1,Ticket")
                    .or_else(|| response.get("ApImg4Ticket"))
                    .and_then(|value| value.as_data())
                    .map(<[u8]>::to_vec)
            })
            .ok_or_else(|| "Apple's signing server returned no Cryptex1 ticket.".to_string()),
        Err(error) => Err(error.to_string()),
    };
    let ticket = match ticket {
        Ok(ticket) => ticket,
        Err(error) => return failed(Stage::Signing, error),
    };
    let properties = match assets.cryptex1_properties() {
        Ok(properties) => properties,
        Err(error) => return failed(Stage::Image, error),
    };
    let installed = async {
        client(provider, rsd)
            .await?
            .install(CryptexInstallRequest::new(
                assets.image.clone(),
                assets.trustcache.clone(),
                ticket,
                assets.info.clone(),
                assets.volumehash.clone(),
                properties,
            ))
            .await?;
        installed_ddi(provider, rsd).await
    }
    .await;
    match installed {
        Ok(Some(installed)) => json!({"installed": true, "ddi": installed_json(&Some(installed))}),
        Ok(None) => failed(
            Stage::Install,
            "cryptexd accepted the image but does not list it as installed.",
        ),
        Err(error) => failed(Stage::Install, error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stages_have_the_names_the_daemon_reads() {
        assert_eq!(
            [
                Stage::Image,
                Stage::Unavailable,
                Stage::Signing,
                Stage::Install
            ]
            .map(Stage::name),
            ["image", "unavailable", "signing", "install"]
        );
        assert_eq!(failed(Stage::Signing, "no")["stage"], "signing");
        assert_eq!(failed(Stage::Signing, "no")["installed"], false);
    }
}
