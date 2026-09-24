use napi::{bindgen_prelude::Buffer, Error, Result, Status};
use napi_derive::napi;

const MINER_WORK_BYTES: usize = 112;

/// Hash the fixed-size MinerWork payload with the official XELIS Hash V3 implementation.
#[napi]
pub fn hash_miner_work(miner_work: Buffer) -> Result<Buffer> {
    if miner_work.len() != MINER_WORK_BYTES {
        return Err(Error::new(
            Status::InvalidArg,
            format!("MinerWork must be exactly {MINER_WORK_BYTES} bytes"),
        ));
    }

    let mut scratch_pad = xelis_hash::v3::ScratchPad::default();
    let hash = xelis_hash::v3::xelis_hash(&miner_work, &mut scratch_pad)
        .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?;
    Ok(Buffer::from(hash.to_vec()))
}
