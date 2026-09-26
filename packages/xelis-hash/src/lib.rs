use std::cell::RefCell;

use napi::{bindgen_prelude::{AsyncTask, Buffer}, Env, Error, Result, Status, Task};
use napi_derive::napi;

const MINER_WORK_BYTES: usize = 112;

thread_local! {
    // The V3 scratchpad is ~543 KB. Keep one per thread (the JS thread and each libuv worker)
    // instead of allocating per hash; the hash fully rewrites it on every call.
    static SCRATCH_PAD: RefCell<xelis_hash::v3::ScratchPad> = RefCell::new(xelis_hash::v3::ScratchPad::default());
}

fn check_len(miner_work: &[u8]) -> Result<()> {
    if miner_work.len() != MINER_WORK_BYTES {
        return Err(Error::new(
            Status::InvalidArg,
            format!("MinerWork must be exactly {MINER_WORK_BYTES} bytes"),
        ));
    }
    Ok(())
}

fn hash(miner_work: &[u8]) -> Result<Vec<u8>> {
    SCRATCH_PAD.with(|scratch_pad| {
        xelis_hash::v3::xelis_hash(miner_work, &mut scratch_pad.borrow_mut())
            .map(|hash| hash.to_vec())
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
    })
}

/// Hash the fixed-size MinerWork payload with the official XELIS Hash V3 implementation.
#[napi]
pub fn hash_miner_work(miner_work: Buffer) -> Result<Buffer> {
    check_len(&miner_work)?;
    Ok(Buffer::from(hash(&miner_work)?))
}

pub struct HashTask {
    miner_work: Vec<u8>,
}

impl Task for HashTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        hash(&self.miner_work)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(Buffer::from(output))
    }
}

/// Same as `hash_miner_work`, but runs on the libuv thread pool and returns a Promise.
#[napi]
pub fn hash_miner_work_async(miner_work: Buffer) -> Result<AsyncTask<HashTask>> {
    check_len(&miner_work)?;
    Ok(AsyncTask::new(HashTask { miner_work: miner_work.to_vec() }))
}
