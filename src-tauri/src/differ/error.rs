use serde::{Serialize, Serializer};

/// Errors surfaced to the UI. Messages are user-facing, in the app's language.
#[derive(Debug)]
pub enum Error {
    NotARepo(String),
    NoCommits,
    RefNotFound(String),
    NoMergeBase { target: String },
    Git { args: String, stderr: String },
    Parse(String),
    Io(std::io::Error),
    /// The blob is a Git LFS pointer whose content was never downloaded.
    LfsMissing,
    /// The question to Claude failed; the message is ready to show.
    Claude(String),
    Internal(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if !crate::idioma::portugues() {
            return match self {
                Error::NotARepo(path) => write!(f, "The folder is not a git repository: {path}"),
                Error::NoCommits => write!(f, "The repository has no commits yet."),
                Error::RefNotFound(name) => write!(f, "Branch not found: {name}"),
                Error::NoMergeBase { target } => {
                    write!(f, "The current branch has no common ancestor with {target}.")
                }
                Error::Git { args, stderr } => write!(f, "Failed to run `git {args}`: {stderr}"),
                Error::Parse(msg) => write!(f, "Could not parse git's output: {msg}"),
                Error::Io(err) => write!(f, "Could not run git: {err}"),
                Error::LfsMissing => write!(
                    f,
                    "File stored in Git LFS and not downloaded yet. Run `git lfs pull` in the repository."
                ),
                Error::Claude(msg) => write!(f, "Claude: {msg}"),
                Error::Internal(msg) => write!(f, "Internal error: {msg}"),
            };
        }
        match self {
            Error::NotARepo(path) => write!(f, "A pasta não é um repositório git: {path}"),
            Error::NoCommits => write!(f, "O repositório ainda não tem commits."),
            Error::RefNotFound(name) => write!(f, "Branch não encontrada: {name}"),
            Error::NoMergeBase { target } => {
                write!(f, "A branch atual não tem ancestral comum com {target}.")
            }
            Error::Git { args, stderr } => write!(f, "Falha ao executar `git {args}`: {stderr}"),
            Error::Parse(msg) => write!(f, "Não foi possível interpretar a saída do git: {msg}"),
            Error::Io(err) => write!(f, "Não foi possível executar o git: {err}"),
            Error::LfsMissing => write!(
                f,
                "Arquivo guardado no Git LFS e ainda não baixado. Rode `git lfs pull` no repositório."
            ),
            Error::Claude(msg) => write!(f, "Claude: {msg}"),
            Error::Internal(msg) => write!(f, "Erro interno: {msg}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(err: std::io::Error) -> Self {
        Error::Io(err)
    }
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
