# Meta App Review capability guide

This file maps NexMeta product features to requested Page permissions. It is a review-preparation document, not a guarantee that Meta will approve a permission.

Only request permissions used by the production product.

## pages_show_list

Purpose:

Allow the authenticated administrator to select which Facebook Pages they manage and connect them to NexMeta.

Demonstration:

1. Administrator opens NexControl Meta panel.
2. Selects Connect Facebook.
3. Grants access.
4. NexMeta discovers the Pages available to that administrator.
5. NexControl displays only Page ID/name/tasks and connection status; tokens remain server-side.

## pages_read_engagement

Purpose:

Read Page metadata/engagement surfaces needed by Page and Messenger management features.

Demonstration:

Show Page status/profile and the relevant read operation in NexControl.

## pages_manage_metadata

Purpose:

Connect Page webhook subscriptions and support Messenger/conversation management metadata.

Demonstration:

1. Connect Page.
2. NexControl runs Configure webhooks.
3. Page subscription state changes to Webhook OK.
4. A test Messenger event arrives at NexMeta.

## pages_manage_posts

Purpose:

Allow the Page administrator to create, schedule, edit and delete Page posts from the private NexControl console.

Demonstration:

1. Open authenticated NexControl.
2. Submit a test Page publication.
3. Show created post ID/result.
4. Edit/delete the same test post.

No public user can access this operation.

## pages_read_user_content

Purpose:

Read Page user-generated content needed for comment moderation/management workflows.

Demonstration:

Show an existing Page post's comments inside the authenticated administrator workflow.

## pages_manage_engagement

Purpose:

Allow the Page administrator to reply to, hide/unhide or remove Page comments.

Demonstration:

1. Select a test comment.
2. Reply/hide it from NexControl.
3. Show the resulting state on the Page.

## pages_messaging

Purpose:

Receive and reply to Messenger conversations in NexMeta and route user requests to compatible Nexus services.

Demonstration:

1. User sends the Page a Messenger message.
2. Meta delivers the webhook.
3. NexMeta persists and routes it.
4. NexMeta replies through the Messenger Send API.
5. NexControl shows the event/audit without exposing the Page token.

The product respects Meta messaging eligibility/window rules enforced by the platform and does not use the permission for unsolicited messaging.

## Data handling statement

NexMeta:

- stores Page Access Tokens encrypted with AES-256-GCM
- does not expose tokens in the browser
- does not expose the App Secret
- uses a dedicated server-to-server NexControl machine credential
- stores Page-scoped Messenger identities rather than treating them as Telegram IDs
- provides an audit log and emergency inbound/outbound kill switch
- supports removal of a connected Page
- stores one-time cross-platform pairing codes only as hashes
- limits pairing codes by expiration and one-time atomic consumption

## Review recording checklist

A review recording should visibly show:

- the NexControl login barrier
- Connect Facebook
- Page selection/connection
- webhook state
- Messenger test conversation
- Page post management if that permission is requested
- comment moderation if those permissions are requested
- no secrets/token values in the UI
