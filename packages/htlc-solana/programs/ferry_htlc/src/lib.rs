use anchor_lang::prelude::*;
use anchor_spl::associated_token::{self, AssociatedToken};
use anchor_spl::token::{self, Mint, Token, TokenAccount};
use sha2::{Digest, Sha256};

declare_id!("DbFyFKCGHZ7Pb3rUsbGtNhYcrvmbGm3qx4mnF4fYnyqN");

#[program]
pub mod ferry_htlc {
    use super::*;

    pub fn lock(
        ctx: Context<Lock>,
        amount: u64,
        hash_lock: [u8; 32],
        deadline: i64,
        recipient: Pubkey,
    ) -> Result<()> {
        let clock = Clock::get()?;
        require!(deadline > clock.unix_timestamp, FerryError::DeadlineInPast);
        require!(amount > 0, FerryError::ZeroAmount);

        let lock_state = &mut ctx.accounts.lock_state;
        lock_state.owner = ctx.accounts.owner.key();
        lock_state.recipient = recipient;
        lock_state.mint = ctx.accounts.mint.key();
        lock_state.amount = amount;
        lock_state.hash_lock = hash_lock;
        lock_state.deadline = deadline;
        lock_state.payer = ctx.accounts.payer.key();
        lock_state.bump = ctx.bumps.lock_state;

        // Transfer tokens from owner's token account to vault
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.key(),
            token::Transfer {
                from: ctx.accounts.owner_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        );
        token::transfer(transfer_ctx, amount)?;

        emit!(Locked {
            lock_state: lock_state.key(),
            owner: lock_state.owner,
            recipient: lock_state.recipient,
            mint: lock_state.mint,
            amount: lock_state.amount,
            hash_lock: lock_state.hash_lock,
            deadline: lock_state.deadline,
        });

        Ok(())
    }

    pub fn claim(ctx: Context<Claim>, secret: Vec<u8>) -> Result<()> {
        require!(secret.len() == 32, FerryError::InvalidSecretLength);

        // SHA-256 hash check
        let mut hasher = Sha256::new();
        hasher.update(&secret);
        let hash: [u8; 32] = hasher.finalize().into();
        require!(
            hash == ctx.accounts.lock_state.hash_lock,
            FerryError::InvalidSecretHash
        );

        // Verify recipient matches
        require_keys_eq!(
            ctx.accounts.recipient.key(),
            ctx.accounts.lock_state.recipient,
            FerryError::UnauthorizedRecipient
        );

        // Verify payer_rent_dest matches the original payer who funded rent
        require_keys_eq!(
            ctx.accounts.payer_rent_dest.key(),
            ctx.accounts.lock_state.payer,
            FerryError::InvalidPayer
        );

        // Ensure recipient token account is the canonical ATA
        let expected_ata = associated_token::get_associated_token_address(
            &ctx.accounts.recipient.key(),
            &ctx.accounts.mint.key(),
        );
        require_keys_eq!(
            ctx.accounts.recipient_token_account.key(),
            expected_ata,
            FerryError::InvalidRecipientTokenAccount
        );

        // Idempotently create recipient ATA if it doesn't exist yet, funded by relayer/payer
        if ctx.accounts.recipient_token_account.data_is_empty() {
            let cpi_accounts = associated_token::Create {
                payer: ctx.accounts.payer.to_account_info(),
                associated_token: ctx.accounts.recipient_token_account.to_account_info(),
                authority: ctx.accounts.recipient.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            };
            let cpi_ctx = CpiContext::new(ctx.accounts.associated_token_program.key(), cpi_accounts);
            associated_token::create(cpi_ctx)?;
        }

        // Transfer funds from vault to recipient ATA using PDA signer seeds
        let owner_bytes = ctx.accounts.lock_state.owner.to_bytes();
        let hash_bytes = ctx.accounts.lock_state.hash_lock;
        let bump = ctx.accounts.lock_state.bump;
        let seeds: &[&[u8]] = &[
            b"lock",
            owner_bytes.as_ref(),
            hash_bytes.as_ref(),
            &[bump],
        ];
        let signer = &[seeds];

        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            token::Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.recipient_token_account.to_account_info(),
                authority: ctx.accounts.lock_state.to_account_info(),
            },
            signer,
        );
        token::transfer(transfer_ctx, ctx.accounts.lock_state.amount)?;

        // Close vault token account and return rent to payer_rent_dest
        let close_vault_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            token::CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.payer_rent_dest.to_account_info(),
                authority: ctx.accounts.lock_state.to_account_info(),
            },
            signer,
        );
        token::close_account(close_vault_ctx)?;

        emit!(Claimed {
            lock_state: ctx.accounts.lock_state.key(),
            recipient: ctx.accounts.recipient.key(),
            amount: ctx.accounts.lock_state.amount,
        });

        // lock_state account is closed via #[account(mut, close = payer_rent_dest)]
        Ok(())
    }

    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp >= ctx.accounts.lock_state.deadline,
            FerryError::DeadlineNotPassed
        );

        // Verify owner matches
        require_keys_eq!(
            ctx.accounts.owner.key(),
            ctx.accounts.lock_state.owner,
            FerryError::UnauthorizedOwner
        );

        // Verify payer_rent_dest matches the original payer who funded rent
        require_keys_eq!(
            ctx.accounts.payer_rent_dest.key(),
            ctx.accounts.lock_state.payer,
            FerryError::InvalidPayer
        );

        // Ensure owner token account is the canonical ATA or owner's account
        let expected_ata = associated_token::get_associated_token_address(
            &ctx.accounts.owner.key(),
            &ctx.accounts.mint.key(),
        );
        require_keys_eq!(
            ctx.accounts.owner_token_account.key(),
            expected_ata,
            FerryError::InvalidOwnerTokenAccount
        );

        // Idempotently create owner ATA if it was closed or doesn't exist
        if ctx.accounts.owner_token_account.data_is_empty() {
            let cpi_accounts = associated_token::Create {
                payer: ctx.accounts.payer.to_account_info(),
                associated_token: ctx.accounts.owner_token_account.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            };
            let cpi_ctx = CpiContext::new(ctx.accounts.associated_token_program.key(), cpi_accounts);
            associated_token::create(cpi_ctx)?;
        }

        // Transfer funds from vault to owner ATA using PDA signer seeds
        let owner_bytes = ctx.accounts.lock_state.owner.to_bytes();
        let hash_bytes = ctx.accounts.lock_state.hash_lock;
        let bump = ctx.accounts.lock_state.bump;
        let seeds: &[&[u8]] = &[
            b"lock",
            owner_bytes.as_ref(),
            hash_bytes.as_ref(),
            &[bump],
        ];
        let signer = &[seeds];

        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            token::Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.owner_token_account.to_account_info(),
                authority: ctx.accounts.lock_state.to_account_info(),
            },
            signer,
        );
        token::transfer(transfer_ctx, ctx.accounts.lock_state.amount)?;

        // Close vault token account and return rent to payer_rent_dest
        let close_vault_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            token::CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.payer_rent_dest.to_account_info(),
                authority: ctx.accounts.lock_state.to_account_info(),
            },
            signer,
        );
        token::close_account(close_vault_ctx)?;

        emit!(Refunded {
            lock_state: ctx.accounts.lock_state.key(),
            owner: ctx.accounts.owner.key(),
            amount: ctx.accounts.lock_state.amount,
        });

        // lock_state account is closed via #[account(mut, close = payer_rent_dest)]
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(amount: u64, hash_lock: [u8; 32], deadline: i64, recipient: Pubkey)]
pub struct Lock<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub owner: Signer<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = payer,
        space = 8 + LockState::INIT_SPACE,
        seeds = [b"lock", owner.key().as_ref(), hash_lock.as_ref()],
        bump,
    )]
    pub lock_state: Account<'info, LockState>,

    #[account(
        init,
        payer = payer,
        token::mint = mint,
        token::authority = lock_state,
        seeds = [b"vault", lock_state.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = mint,
        token::authority = owner,
    )]
    pub owner_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"lock", lock_state.owner.as_ref(), lock_state.hash_lock.as_ref()],
        bump = lock_state.bump,
        close = payer_rent_dest,
    )]
    pub lock_state: Account<'info, LockState>,

    #[account(
        mut,
        seeds = [b"vault", lock_state.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = lock_state,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// CHECK: Validated against lock_state.recipient
    pub recipient: UncheckedAccount<'info>,

    /// CHECK: Checked against canonical ATA and created idempotently if needed
    #[account(mut)]
    pub recipient_token_account: UncheckedAccount<'info>,

    #[account(
        address = lock_state.mint @ FerryError::InvalidMint
    )]
    pub mint: Account<'info, Mint>,

    /// CHECK: Validated against lock_state.payer
    #[account(mut)]
    pub payer_rent_dest: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"lock", lock_state.owner.as_ref(), lock_state.hash_lock.as_ref()],
        bump = lock_state.bump,
        close = payer_rent_dest,
    )]
    pub lock_state: Account<'info, LockState>,

    #[account(
        mut,
        seeds = [b"vault", lock_state.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = lock_state,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// CHECK: Validated against lock_state.owner
    pub owner: UncheckedAccount<'info>,

    /// CHECK: Checked against canonical ATA and created idempotently if needed
    #[account(mut)]
    pub owner_token_account: UncheckedAccount<'info>,

    #[account(
        address = lock_state.mint @ FerryError::InvalidMint
    )]
    pub mint: Account<'info, Mint>,

    /// CHECK: Validated against lock_state.payer
    #[account(mut)]
    pub payer_rent_dest: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct LockState {
    pub owner: Pubkey,
    pub recipient: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub hash_lock: [u8; 32],
    pub deadline: i64,
    pub payer: Pubkey,
    pub bump: u8,
}

#[event]
pub struct Locked {
    pub lock_state: Pubkey,
    pub owner: Pubkey,
    pub recipient: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub hash_lock: [u8; 32],
    pub deadline: i64,
}

#[event]
pub struct Claimed {
    pub lock_state: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Refunded {
    pub lock_state: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum FerryError {
    #[msg("Deadline must be in the future")]
    DeadlineInPast,

    #[msg("Lock amount must be greater than zero")]
    ZeroAmount,

    #[msg("Secret must be exactly 32 bytes")]
    InvalidSecretLength,

    #[msg("Provided secret does not match hash lock")]
    InvalidSecretHash,

    #[msg("Recipient does not match lock recipient")]
    UnauthorizedRecipient,

    #[msg("Owner does not match lock owner")]
    UnauthorizedOwner,

    #[msg("Payer does not match lock payer")]
    InvalidPayer,

    #[msg("Mint does not match lock mint")]
    InvalidMint,

    #[msg("Recipient token account is not canonical ATA")]
    InvalidRecipientTokenAccount,

    #[msg("Owner token account is not canonical ATA")]
    InvalidOwnerTokenAccount,

    #[msg("Deadline has not yet passed")]
    DeadlineNotPassed,
}
